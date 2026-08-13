/**
 * GitHub App の資格情報を環境変数から読む。
 *
 * **`process.env` を触ってよいのは infrastructure だけ**（`AGENTS.md` §3）。
 * **値はログにも例外にも出さない。** 秘密鍵がここを通る。
 */

import { z } from "zod";

/**
 * App として署名するために要るもの。
 *
 * **installation は含めない。** installation は設定ではなく**実行時の状態**で、
 * App を新しいリポジトリへ入れるたびに増える（`resolveRepositoryInstallation`）。
 */
export type AppCredentials = {
  readonly appId: string;
  /** PEM。**中身を扱うのは署名のときだけで、どこにも出さない。** */
  readonly privateKey: string;
};

/**
 * ユーザーとしてログインするために要るもの。
 *
 * **App として署名する資格とは別である**（`AGENTS.md` §6「トークンは 2 種類ある」）。
 * **こちらは「誰が何を見られるか」**を得るために使い、**App の秘密鍵とは用途が違う**
 * ——**同じ型にまとめると、片方しか要らない場所へ両方を渡すことになる。**
 */
export type OAuthCredentials = {
  readonly clientId: string;
  readonly clientSecret: string;
};

/** 読む環境変数の名前。`.env.example` と揃える。 */
const APP_ID = "GITHUB_APP_ID";
const PRIVATE_KEY = "GITHUB_APP_PRIVATE_KEY";
const CLIENT_ID = "GITHUB_APP_CLIENT_ID";
const CLIENT_SECRET = "GITHUB_APP_CLIENT_SECRET";

/**
 * 環境変数から資格情報を組み立てる。
 *
 * **欠けていたら投げる。** 空文字のまま進めると、症状は GitHub からの 401 になり、
 * **設定漏れなのか権限不足なのか分からなくなる**。
 */
export function readAppCredentials(
  env: Readonly<Record<string, string | undefined>>,
): AppCredentials {
  return {
    appId: required(env, APP_ID, idSchema),
    privateKey: toPem(required(env, PRIVATE_KEY, secretSchema)),
  };
}

/**
 * 環境変数から OAuth の資格情報を組み立てる。
 *
 * **欠けていたら投げる。** **空文字のまま進めると、ログインが GitHub 側で
 * 「client_id が不正」になり、設定漏れだと分からなくなる。**
 */
export function readOAuthCredentials(
  env: Readonly<Record<string, string | undefined>>,
): OAuthCredentials {
  return {
    clientId: required(env, CLIENT_ID, secretSchema),
    clientSecret: required(env, CLIENT_SECRET, secretSchema),
  };
}

/**
 * **App ID は GitHub が振る数値である。** 空白だけの値や名前らしき文字列を通すと、
 * `iss` に載ってから 401 になり、**設定ミスだと分からなくなる**。
 * 前後の空白は `.env` を手で編集すると混ざるので落とす。
 */
const idSchema = z.string().trim().regex(/^\d+$/);

/**
 * **秘密鍵は空かどうかだけを見る。** PEM の形まで検証しても、署名が通るかは
 * 通してみないと分からない。二重に持つ意味がない。
 */
const secretSchema = z.string().refine((value) => value.trim() !== "");

/** **名前だけを載せる。** 値を載せると、秘密鍵がそのままログへ流れる。 */
function required(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  schema: z.ZodType<string, unknown>,
): string {
  const parsed = schema.safeParse(env[name]);
  if (!parsed.success) {
    // **Zod のエラーを持ち上げない。** 検証結果には値が入りうる
    throw new Error(`環境変数が設定されていないか、形式が違います: ${name}`);
  }
  return parsed.data;
}

/**
 * 1 行に潰された PEM を改行へ戻す。
 *
 * **`.env` は改行を持てない**ので、`\n` にエスケープして入れる決まりにしている
 * （`.env.example` を参照）。戻さないと署名が通らず、症状は 401 になる。
 * すでに改行が入っている場合は何も起きない。
 */
function toPem(value: string): string {
  return value.replaceAll("\\n", "\n");
}
