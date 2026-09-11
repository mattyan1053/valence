/**
 * **入口の画面が出す 2 つを、1 度の解決から作る**（#686 のレビュー）。
 *
 * **`/` は見えるリポジトリの一覧と、横断の盤面を出す**——**どちらも同じ
 * `/user/repos` を要る。** **別々に呼ぶと、100 件を超えるアカウントでは
 * 全ページが二重**になる（**1 往復 1.3 秒**の実測がそのまま 2 倍）。
 *
 * **解決そのものは `resolveVisibleRepositories` が持つ**——**ここは
 * 「1 度呼んで、両方へ渡す」だけ**である。
 */

import type { ResolvedVisibleRepositories } from "../auth/resolve-visible-repositories";
import type { CrossRepositoryPullRequests } from "../ports/cross-repository-pull-requests";
import type { VisibleRepositoriesResult } from "../repositories/list-visible-repositories";
import { toVisibleRepositoriesResult } from "../repositories/list-visible-repositories";
import type { CrossRepositoryBoardResult } from "./view-cross-repository-board";
import { viewCrossRepositoryBoard } from "./view-cross-repository-board";

export type HomeView = {
  readonly repositories: VisibleRepositoriesResult;
  readonly cross: CrossRepositoryBoardResult;
};

export type ViewHomeInput = {
  /** **1 度だけ呼ぶ**（上記）。**呼ぶ回数がこの流れの本体**である。 */
  readonly resolve: () => Promise<ResolvedVisibleRepositories>;
  readonly pullRequests: CrossRepositoryPullRequests;
  readonly deadline?: () => AbortSignal;
};

export async function viewHome({
  resolve,
  pullRequests,
  deadline,
}: ViewHomeInput): Promise<HomeView> {
  const resolved = await resolve();
  return {
    repositories: toVisibleRepositoriesResult(resolved),
    cross: await viewCrossRepositoryBoard({ resolved, pullRequests, deadline }),
  };
}
