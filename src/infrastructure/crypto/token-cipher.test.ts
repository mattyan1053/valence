import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken, readEncryptionKey } from "./token-cipher";

/**
 * **トークンを平文で置かない**（`AGENTS.md` §6）。
 *
 * **倒す先は 2 つある**（#210）。
 *
 * - **書けたのに読めない**（可逆でない・鍵の取り違え）
 * - **読めてはいけない人に読める**（ここでは**鍵を持たない側**）
 *
 * **片方だけ見ると、両方の向きで緑になる形が残る。**
 */
describe("トークンの暗号", () => {
  /** **暗号文が「誰のものか」を持つ**（#215 のレビュー）。 */
  const ALICE = "11111111-1111-1111-1111-111111111111";
  const BOB = "22222222-2222-2222-2222-222222222222";

  const key = readEncryptionKey({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") });
  const key2 = readEncryptionKey({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") });

  it("暗号化したものを、同じ鍵で戻せる", () => {
    // **戻せなければ、保存した時点で失われている**——**症状は「ログインし直しても
    // 直らない」**になり、**書けているぶん気づきにくい**
    expect(decryptToken(key, ALICE, encryptToken(key, ALICE, "ghu_secret"))).toBe("ghu_secret");
  });

  it("空でない中身は、そのまま残る（改行や記号も）", () => {
    const value = "ghr_a+b/c=\nd";

    expect(decryptToken(key, ALICE, encryptToken(key, ALICE, value))).toBe(value);
  });

  it("違う鍵では戻せない", () => {
    // **鍵の取り違えを、静かに素通りさせない**
    const sealed = encryptToken(key, ALICE, "ghu_secret");

    expect(() => decryptToken(key2, ALICE, sealed)).toThrow(/復号できません/);
  });

  it("同じ中身でも、毎回違う暗号文になる", () => {
    // **決定的だと、DB を見るだけで「同じトークンを使い回している人」が分かる**
    // ——**中身を読めなくても、等しいことが漏れる**
    expect(encryptToken(key, ALICE, "ghu_secret")).not.toBe(encryptToken(key, ALICE, "ghu_secret"));
  });

  it("1 文字でも書き換えられていたら、戻さない", () => {
    // **改竄を検出できない暗号だと、書き換えた値をそのまま返す**
    const sealed = encryptToken(key, ALICE, "ghu_secret");
    const flipped = `${sealed.slice(0, -2)}${sealed.at(-2) === "A" ? "B" : "A"}${sealed.at(-1)}`;

    expect(() => decryptToken(key, ALICE, flipped)).toThrow(/復号できません/);
  });

  it("形の違うものを渡されても、戻さない", () => {
    // **DB の値は壊れうる**（移行の失敗、手で書き換え）——**平文として返さない**
    expect(() => decryptToken(key, ALICE, "これは暗号文ではない")).toThrow(/復号できません/);
    expect(() => decryptToken(key, ALICE, "")).toThrow(/復号できません/);
  });

  it("他人の行へ写しても、その人としては戻せない", () => {
    // **鍵はテナント共通**なので、**暗号文だけでは「誰のものか」が分からない**——
    // **A の行から B の行へ写すと、改竄されていない暗号文として復号に成功し、
    // B の処理が A のトークンで走る**（#215 のレビュー）。
    //
    // **症状は「権限が正しく効いている」ように見える**——**B は普通に画面を使えるが、
    // 見ているのは A の見えるものである。** **誰も落ちない。**
    const sealed = encryptToken(key, ALICE, "ghu_alice");

    expect(() => decryptToken(key, BOB, sealed)).toThrow(/復号できません/);
    expect(decryptToken(key, ALICE, sealed), "本人なら戻せる").toBe("ghu_alice");
  });

  it("利用者 ID が空なら、封じない", () => {
    // **空を許すと「誰のものでもない暗号文」が作れる**——**それは全員の行で通る**
    expect(() => encryptToken(key, "", "ghu_secret")).toThrow(/利用者/);
    expect(() => decryptToken(key, "", encryptToken(key, ALICE, "x"))).toThrow(/利用者/);
  });

  it("認証タグを切り詰めたものは、戻さない", () => {
    // **GCM は短いタグも受け付ける**（#215 のレビュー）——**4 バイトへ切り詰めても
    // 同じ平文を返しうる**。**偽造耐性が 128 bit から 32 bit へ落ちる**ので、
    // **「書き換えられたものは戻さない」が成立しなくなる。**
    const [iv, tag, body] = encryptToken(key, ALICE, "ghu_secret").split(".") as [
      string,
      string,
      string,
    ];
    const shortTag = Buffer.from(tag, "base64").subarray(0, 4).toString("base64");

    expect(() => decryptToken(key, ALICE, [iv, shortTag, body].join("."))).toThrow(
      /復号できません/,
    );
  });

  it("鍵が短ければ、使う前に落ちる", () => {
    // **短い鍵で静かに動くと、弱いまま本番へ出る**——**設定の誤りは入口で止める**
    expect(() =>
      readEncryptionKey({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(16, 7).toString("base64") }),
    ).toThrow("TOKEN_ENCRYPTION_KEY");
  });

  it("鍵が無ければ、使う前に落ちる", () => {
    expect(() => readEncryptionKey({})).toThrow("TOKEN_ENCRYPTION_KEY");
  });

  it("鍵が base64 でなければ、使う前に落ちる", () => {
    expect(() => readEncryptionKey({ TOKEN_ENCRYPTION_KEY: "!!!" })).toThrow(
      "TOKEN_ENCRYPTION_KEY",
    );
  });

  it("base64 として崩れているものは、長さが合っても落ちる", () => {
    // **`Buffer.from` は不正な文字を黙って捨てる**（#215 のレビュー）——
    // **末尾の `=` を `!` に変えても 32 バイトへ復号され、長さ検査を通る。**
    // **「base64 でなければ落とす」が成立していなかった。**
    const valid = Buffer.alloc(32, 7).toString("base64");
    const broken = valid.replace(/=$/, "!");

    expect(broken, "この鍵の形なら末尾に padding がある").not.toBe(valid);
    expect(() => readEncryptionKey({ TOKEN_ENCRYPTION_KEY: broken })).toThrow(
      "TOKEN_ENCRYPTION_KEY",
    );
  });

  it("落ちるときに、鍵そのものを載せない", () => {
    // **例外の本文にも秘密を入れない**（§6）
    const secret = Buffer.alloc(16, 3).toString("base64");

    expect(() => readEncryptionKey({ TOKEN_ENCRYPTION_KEY: secret })).toThrow(
      new RegExp(`^(?!.*${secret.replaceAll("+", "\\+")}).*$`, "s"),
    );
  });
});
