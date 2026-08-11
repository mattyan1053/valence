/**
 * リポジトリの installation を実行時に解決する。
 *
 * **installation は設定ではない。** installation は**アカウント（org / ユーザー）ごと**に
 * あり、同じアカウントのリポジトリは同じ installation を共有する。**増えるのは
 * インストール先のアカウントが増えたとき**なので、設定に固定すると 1 つしか扱えない。
 * 引くのは **App として**（installation token はまだ持っていない段階である）。
 */

import { z } from "zod";
import type { AppCredentials } from "./app-credentials";
import { createAppJwt } from "./app-jwt";

const API_ORIGIN = "https://api.github.com";

/** どのリポジトリを見るか。 */
export type GitHubRepository = {
  readonly owner: string;
  readonly name: string;
};

/**
 * **URL へ入れる前に検証する**（`AGENTS.md` §6）。
 *
 * この要求には **App の JWT が載る**ので、`..%2F..%2Fapp` のような値をそのまま
 * 入れると、**App の資格で別の endpoint を叩く**ことになる。いまの呼び出し側は
 * テストだけだが、**UI からリポジトリを選ばせた瞬間に外部入力になる**。
 *
 * **落ちたら投げる。直して続行しない。** 畳まれた先を黙って見に行くほうの事故になる。
 *
 * 弾くのは**値そのものが `.` か `..` のとき**だけである。`fetch` は WHATWG URL に従って
 * その 2 つを畳むので、`/repos/./valence/...` は `/repos/valence/...` へ変わる。
 * **`foo..bar` は GitHub で有効な名前**なので弾かない（`/` と `%` を落としてあるため、
 * 値は必ず 1 セグメントで、中の `..` では上へ抜けられない）。
 */
const nameSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]+$/)
  .refine((value) => value !== "." && value !== "..");

export type ResolveInstallationOptions = {
  readonly credentials: AppCredentials;
  readonly repository: GitHubRepository;
  readonly now: Date;
  /** **差し替えるための引数であって、抽象ではない**（#64 と同じ形）。 */
  readonly fetchImpl?: typeof fetch;
  /**
   * 打ち切りの合図。
   *
   * **認証の往復にも届かせる。** ここが素通しだと、**呼んだ側が縮退したあとも
   * installation の解決だけが走り続ける**——**止まるのは呼んだ側だけ**になる。
   */
  readonly signal?: AbortSignal;
};

/**
 * 使う項目だけを検証する。
 *
 * **`id` は正の整数**である。`0` や負数を通すと `/app/installations/0/access_tokens`
 * へ進み、**原因の分からない失敗**になる（下の「見つからなければ投げる」が守れない）。
 */
const responseSchema = z.object({ id: z.number().int().positive() });

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
  signal,
}: ResolveInstallationOptions): Promise<string> {
  requireName(repository.owner, "owner");
  requireName(repository.name, "name");

  const response = await fetchImpl(
    `${API_ORIGIN}/repos/${repository.owner}/${repository.name}/installation`,
    {
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
    throw installationRequestError(response.status);
  }

  const parsed = responseSchema.safeParse(safeJson(body));
  if (!parsed.success) {
    throw installationResponseError(response.status);
  }
  return String(parsed.data.id);
}

/** **値は載せない。** 外から来た文字列をそのままログへ流さない。 */
function requireName(value: string, field: "owner" | "name"): void {
  if (!nameSchema.safeParse(value).success) {
    throw new Error(`リポジトリの指定が不正です: ${field}`);
  }
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
