/**
 * ユーザートークンを、置き場へ入れる前に封じる。
 *
 * **トークンは平文で残さない** (`AGENTS.md` §6)。**DB にも、ログにも、
 * エラーの本文にも**——**置き場を読めた誰かが、そのまま GitHub を叩けてしまう。**
 *
 * **RLS は「誰が行を読めるか」を決めるが、行の中身までは隠さない。** 二重にする
 * 理由は、**片方が外れたときに、もう片方だけでは全部が漏れないため**である
 * (**バックアップ・移行・監査ログなど、RLS の外を通る経路がある**)。
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** 使う鍵。**中身は持ち出さない** (型で包んで、そのまま文字列にしない)。 */
export type EncryptionKey = {
  readonly bytes: Buffer;
};

/** 読む環境変数の名前。`.env.example` と揃える。 */
const KEY_NAME = "TOKEN_ENCRYPTION_KEY";

/** AES-256-GCM。**鍵は 32 バイト**、**nonce は 12 バイト**が推奨。 */
const KEY_BYTES = 32;
const IV_BYTES = 12;
/**
 * **認証タグは 16 バイトに固定する。**
 *
 * **GCM は短いタグも受け付ける**ので、**空でないことしか見ないと、16 バイトを
 * 4 バイトへ切り詰めた値でも同じ平文を返しうる** (#215 のレビュー)——
 * **偽造耐性が 128 bit から 32 bit へ落ちる。**
 */
const TAG_BYTES = 16;
const ALGORITHM = "aes-256-gcm";

/**
 * 環境変数から鍵を読む。
 *
 * **短い鍵で静かに動かない。** **弱いまま本番へ出ると、外から見て分からない**
 * ——**設定の誤りは入口で止める** (`readAppCredentials` と同じ判断)。
 *
 * **名前だけを載せる。** **値を載せると、鍵がそのままログへ流れる。**
 */
export function readEncryptionKey(
  env: Readonly<Record<string, string | undefined>>,
): EncryptionKey {
  const raw = env[KEY_NAME];
  if (raw === undefined || raw.trim() === "") {
    throw new Error(`環境変数が設定されていないか、形式が違います: ${KEY_NAME}`);
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(raw, "base64");
  } catch {
    throw new Error(`環境変数が設定されていないか、形式が違います: ${KEY_NAME}`);
  }
  // **`Buffer.from` は base64 でない文字を黙って捨てる。** **長さだけでは足りない**
  // ——**末尾の `=` を `!` に変えても 32 バイトへ復号され、長さ検査を通る** (#215 の
  // レビュー)。**戻して同じ字面になるか**まで見る (**正規形と一致するか**)。
  if (bytes.length !== KEY_BYTES || bytes.toString("base64") !== raw.trim()) {
    throw new Error(`環境変数が設定されていないか、形式が違います: ${KEY_NAME}`);
  }
  return { bytes };
}

/**
 * 封じたときのエラー。
 *
 * **理由を分けない。** **「鍵が違う」と「書き換えられている」を呼ぶ側へ伝えると、
 * 試した相手にどちらかを教えることになる**——**呼ぶ側にできることは同じ** (人へ渡す)。
 * **中身も載せない。**
 */
function sealedError(): Error {
  return new Error("保存されているトークンを復号できません");
}

/**
 * **その暗号文が「誰のものか」。**
 *
 * **鍵はテナント共通**なので、**暗号文だけでは持ち主が分からない**——**A の行から
 * B の行へ写すと、改竄されていない暗号文として復号に成功し、B の処理が A の
 * トークンで走る** (#215 のレビュー)。**症状は「権限が正しく効いている」ように見える**
 * ——**B は普通に画面を使えるが、見ているのは A の見えるものである。誰も落ちない。**
 *
 * **空を許さない。** **「誰のものでもない暗号文」は、全員の行で通る。**
 */
function ownerAad(userId: string): Buffer {
  if (userId.trim() === "") {
    throw new Error("利用者を特定できないまま、トークンを封じることはできません");
  }
  return Buffer.from(userId, "utf8");
}

/**
 * 封じる。
 *
 * **毎回ちがう nonce を使う。** **決定的だと、DB を見るだけで「同じトークンを
 * 使い回している人」が分かる**——**中身を読めなくても、等しいことが漏れる。**
 *
 * 形は `<nonce>.<認証タグ>.<暗号文>` (どれも base64)。
 */
export function encryptToken(key: EncryptionKey, userId: string, plain: string): string {
  const aad = ownerAad(userId);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key.bytes, iv);
  cipher.setAAD(aad);
  const sealed = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    sealed.toString("base64"),
  ].join(".");
}

/**
 * 戻す。
 *
 * **形が違うもの・書き換えられたものは、平文として返さない。** **DB の値は壊れうる**
 * (移行の失敗、手で書き換え) ので、**「読めた」を「正しい」へ倒さない。**
 */
export function decryptToken(key: EncryptionKey, userId: string, sealed: string): string {
  const aad = ownerAad(userId);
  const parts = sealed.split(".");
  if (parts.length !== 3) {
    throw sealedError();
  }
  const [rawIv, rawTag, rawBody] = parts as [string, string, string];
  const iv = Buffer.from(rawIv, "base64");
  const tag = Buffer.from(rawTag, "base64");
  const body = Buffer.from(rawBody, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw sealedError();
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key.bytes, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    // **元の例外を持ち上げない。** **鍵や中身が混ざりうる。**
    throw sealedError();
  }
}
