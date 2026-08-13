/**
 * ユーザートークン (user-to-server) を取る・更新する。
 *
 * **installation トークンとは別物である** (`AGENTS.md` §6)。
 * **ユーザートークンは「誰が何を見られるか」**を表し、**installation トークンは
 * 「リポジトリへの操作」**を表す——**閲覧権限の判定を後者で代用できない**
 * (誰がログインしていても同じものが見えてしまう)。
 *
 * **この App は "User-to-server token expiration" にオプトイン済み**なので、
 * **`expires_in` と `refresh_token` が返る**。**返らなければ失敗させる**——
 * **保存するものが無いまま静かに進むと、8 時間後に
 * 「ログインしているのに何も見えない」**という、**遅れて出る失敗**になる。
 * **設定画面の見え方ではなく、返ってきたもので裏を取る。**
 */

import { z } from "zod";
import type { OAuthCredentials } from "./app-credentials";

/** GitHub が返した 1 組。**期限は時刻にして返す** (呼ぶ側で計算し直させない)。 */
export type UserTokenPair = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: Date;
};

/** 差し替えられる `fetch`。**通信そのものは薄く保つ。** */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const TOKEN_URL = "https://github.com/login/oauth/access_token";

/**
 * 断られたときのエラー。
 *
 * **応答の中身を載せない。** **この要求の応答には token そのものが入る**ので、
 * そのまま文面にすると秘密がログへ流れる (`AGENTS.md` §6
 * 「出力に何が含まれうるかで判断する」)。載せるのは状態コードだけ。
 */
function requestError(status: number): Error {
  return new Error(`ユーザートークンを取得できませんでした (HTTP ${status})`);
}

/**
 * 応答は返ってきたが読めなかったときのエラー。
 *
 * **「断られた」と別の文面にする。** 同じにすると、**`HTTP 200` で
 * 「取得できませんでした」**と出て、**GitHub が断ったのか、こちらが読めなかったのか**が
 * 分からなくなる。ここでも中身は載せない。
 */
function responseError(status: number): Error {
  return new Error(`ユーザートークンの応答を読めませんでした (HTTP ${status})`);
}

/**
 * 使う項目だけを検証する。
 *
 * **`refresh_token` と `expires_in` を必須にする。** **オプトアウトされた App では
 * 返らない**——**そのとき、この設計は成り立たない**ので、**そこで止める。**
 * **`error` を返す応答は、この形に当たらないので同じ経路で落ちる**
 * (**GitHub は HTTP 200 で `error` を返しうる**)。
 */
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
});

async function requestTokens(body: URLSearchParams, fetcher: Fetcher, now: Date) {
  const response = await fetcher(TOKEN_URL, {
    method: "POST",
    headers: {
      // **既定では `application/x-www-form-urlencoded` が返る。**
      // **JSON で受け取ることを明示しないと、検証へ渡す前に読めない。**
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw requestError(response.status);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw responseError(response.status);
  }

  const parsed = tokenSchema.safeParse(payload);
  if (!parsed.success) {
    throw responseError(response.status);
  }

  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresAt: new Date(now.getTime() + parsed.data.expires_in * 1000),
  };
}

export type ExchangeCodeInput = {
  readonly credentials: OAuthCredentials;
  readonly code: string;
  readonly fetcher: Fetcher;
  readonly now: Date;
};

/**
 * ログインで受け取った code を、1 組のトークンへ交換する。
 *
 * **秘密は本文へ入れる。** URL のクエリに置くと、**ログや履歴に残りやすい**。
 */
export function exchangeCode({
  credentials,
  code,
  fetcher,
  now,
}: ExchangeCodeInput): Promise<UserTokenPair> {
  return requestTokens(
    new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      code,
    }),
    fetcher,
    now,
  );
}

export type RefreshUserTokensInput = {
  readonly credentials: OAuthCredentials;
  readonly refreshToken: string;
  readonly fetcher: Fetcher;
  readonly now: Date;
};

/**
 * 失効したものを、保存してある refresh token で更新する。
 *
 * **返ってくる refresh token も新しくなる。** **GitHub 側で古いものは使えなくなる**ので、
 * **保存し直すまでが 1 組**である (保存し損ねると、次の要求で必ず失敗する)。
 */
export function refreshUserTokens({
  credentials,
  refreshToken,
  fetcher,
  now,
}: RefreshUserTokensInput): Promise<UserTokenPair> {
  return requestTokens(
    new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    fetcher,
    now,
  );
}
