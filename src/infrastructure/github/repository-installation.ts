/**
 * リポジトリの installation を実行時に解決する。
 *
 * **installation は設定ではない。** App ごとに 1 つではなく、**App を新しい
 * リポジトリへ入れるたびに増える**ので、環境変数に固定すると 1 つしか扱えない。
 * 引くのは **App として**（installation token はまだ持っていない段階である）。
 */

import { z } from "zod";
import type { AppCredentials } from "./app-credentials";
import { createAppJwt } from "./app-jwt";

const API_ORIGIN = "https://api.github.com";

/** どのリポジトリを見るか。**中身は境界の外から来る**ので、そのまま URL へ入れる。 */
export type GitHubRepository = {
  readonly owner: string;
  readonly name: string;
};

export type ResolveInstallationOptions = {
  readonly credentials: AppCredentials;
  readonly repository: GitHubRepository;
  readonly now: Date;
  /** **差し替えるための引数であって、抽象ではない**（#64 と同じ形）。 */
  readonly fetchImpl?: typeof fetch;
};

/** 使う項目だけを検証する。`id` は GitHub が振る数値。 */
const responseSchema = z.object({ id: z.number().int() });

/**
 * そのリポジトリに入っている installation の ID を返す。
 *
 * **見つからなければ投げる。** 空や `0` を返すと URL に載り、症状が「PR が 0 件」や
 * 401 に化けて、**App が入っていないことだと分からなくなる**。
 */
export async function resolveRepositoryInstallation({
  credentials,
  repository,
  now,
  fetchImpl = fetch,
}: ResolveInstallationOptions): Promise<string> {
  const response = await fetchImpl(
    `${API_ORIGIN}/repos/${repository.owner}/${repository.name}/installation`,
    {
      headers: {
        authorization: `Bearer ${createAppJwt(credentials, now)}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    },
  );

  const body = await response.text();
  if (!response.ok) {
    throw installationRequestError(response.status);
  }

  const parsed = responseSchema.safeParse(safeJson(body));
  if (!parsed.success) {
    throw installationResponseError(response.status);
  }
  return String(parsed.data.id);
}

/** **応答の中身を載せない**（§6「出力に何が含まれうるかで判断する」）。 */
function installationRequestError(status: number): Error {
  return new Error(`リポジトリの installation を取得できませんでした (HTTP ${status})`);
}

/** **「断られた」と「読めなかった」を分ける**（#64 と同じ理由）。 */
function installationResponseError(status: number): Error {
  return new Error(`リポジトリの installation の応答を読めませんでした (HTTP ${status})`);
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
