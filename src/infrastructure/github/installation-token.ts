/**
 * installation token を取る。
 *
 * Valence は GitHub App なので、個人のアクセストークンではなく
 * **App の秘密鍵 → JWT → installation token** の順で資格を得る。
 *
 * **判断は通信の外に出す。** 取り直すかどうかは引数だけで決まるので、
 * ネットワーク無しで確かめられる。HTTP を叩くところは薄く保つ。
 */

import { z } from "zod";
import type { AppCredentials } from "./app-credentials";
import { createAppJwt } from "./app-jwt";

/** 取得した token と、その期限。 */
export type InstallationToken = {
  readonly token: string;
  readonly expiresAt: Date;
};

/**
 * **期限の何秒前から取り直すか。**
 *
 * 期限ちょうどまで使うと、**要求を送っている途中で切れうる**。切れた token は 401 を
 * 返すので、症状が「権限が無い」と見分けられなくなる。
 */
const REFRESH_MARGIN_SECONDS = 60;

/** 1 時間で切れる token を使い回してよいか。**持っていない場合も取り直す側に倒す。** */
export function needsRefresh(token: InstallationToken | undefined, now: Date): boolean {
  if (token === undefined) {
    return true;
  }
  return token.expiresAt.getTime() - now.getTime() <= REFRESH_MARGIN_SECONDS * 1000;
}

/**
 * 取得に失敗したときのエラー。
 *
 * **応答の中身を載せない。** この要求の応答には **token そのものが入る**ので、
 * そのまま文面にすると秘密がログへ流れる（`AGENTS.md` §6
 * 「出力に何が含まれうるかで判断する」）。載せるのは状態コードだけ。
 */
export function tokenRequestError(status: number, _body: string): Error {
  return new Error(`installation token を取得できませんでした (HTTP ${status})`);
}

/**
 * 応答は返ってきたが読めなかったときのエラー。
 *
 * **「断られた」と別の文面にする。** 同じにすると、`HTTP 200` で
 * 「取得できませんでした」と出て、**GitHub が断ったのか、こちらが読めなかったのか**が
 * 分からなくなる。ここでも中身は載せない。
 */
export function tokenResponseError(status: number, _body: string): Error {
  return new Error(`installation token の応答を読めませんでした (HTTP ${status})`);
}

/** 応答のうち使う項目だけを検証する。 */
const responseSchema = z.object({
  token: z.string().min(1),
  expires_at: z.iso.datetime(),
});

/**
 * installation token を取ってくる。
 *
 * **失敗したら投げる。** 空文字や `null` を返すと、「取れなかった」が
 * 「権限が無い」や「PR が 0 件」に化ける。
 */
export async function requestInstallationToken(
  credentials: AppCredentials,
  /**
   * どの installation の token か。**跨いで使い回せない**ので、呼ぶ側が
   * `resolveRepositoryInstallation` などで解決してから渡す。
   */
  installationId: string,
  now: Date,
  /**
   * **差し替えるための引数であって、抽象ではない。** interface も HTTP クライアントの層も
   * 作らない。ここが引数でないと、URL・メソッド・認証ヘッダーが壊れても
   * **実際に GitHub へ繋ぐまで分からない**。
   */
  fetchImpl: typeof fetch = fetch,
  /**
   * 打ち切りの合図。**認証の往復にも届かせる**——ここが素通しだと、
   * **呼んだ側が縮退したあとも token の発行だけが走り続ける**。
   */
  signal?: AbortSignal,
): Promise<InstallationToken> {
  const response = await fetchImpl(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      signal,
      headers: {
        authorization: `Bearer ${createAppJwt(credentials, now)}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    },
  );

  const body = await response.text();
  if (!response.ok) {
    throw tokenRequestError(response.status, body);
  }

  const parsed = responseSchema.safeParse(safeJson(body));
  if (!parsed.success) {
    // **検証に落ちた中身も載せない。** token が入っている応答である
    throw tokenResponseError(response.status, body);
  }
  return { token: parsed.data.token, expiresAt: new Date(parsed.data.expires_at) };
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
