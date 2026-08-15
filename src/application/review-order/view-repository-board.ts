/**
 * **1 つのリポジトリの盤面を、画面へ渡せる形にする**（#314）。
 *
 * **この流れの本体は認可である。**
 *
 * **「誰が何を見てよいか」はユーザートークンが表す**（`AGENTS.md` §6）。
 * **PR のデータを取るのは installation トークン**でよいが、**あれは
 * 「リポジトリへの操作」**なので、**それだけで出すと、誰がログインしていても
 * 同じものが見える**——**確かめてから取りに行く。**
 *
 * **見られないリポジトリでは、存在も漏らさない。** **「権限がありません」と
 * 「ありません」を区別できる応答にしない**ので、**どちらも `not-found` である。**
 *
 * **倒し分けは `listVisibleRepositories` と揃える**（ログインしていない / 入り直す /
 * 故障）——**行き先が違うものを 1 つにまとめない**という理由がそのまま当たる。
 */

import { authorizeRepository } from "../auth/authorize-repository";
import type { UsableToken } from "../auth/ensure-usable-token";
import type { UserTokenStore } from "../ports/user-token-store";
import type { VisibleRepositories, VisibleRepository } from "../ports/visible-repositories";
import type { ReviewOrderPlan } from "./plan-review-order";

export type RepositoryBoardResult =
  /** ログインしていない。**誰の権限も無いので、データを出さない**（§6）。 */
  | { readonly kind: "signed-out" }
  /** 失効していて、更新もできなかった。**入口へ戻す。** */
  | { readonly kind: "needs-login" }
  /** **入り直しても直らない**（置き場が落ちている / 一覧を読めない）。 */
  | { readonly kind: "unavailable" }
  /**
   * **そのユーザーには無い。**
   *
   * **「見えない」と「存在しない」を分けない**（§6）——**分けた瞬間に、
   * 見えないほうの存在を教えることになる。**
   */
  | { readonly kind: "not-found" }
  | { readonly kind: "board"; readonly plan: ReviewOrderPlan };

export type ViewRepositoryBoardInput = {
  /** どのリポジトリを見るか。**要求ごとに決まる**（設定に固定しない。§1）。 */
  readonly repository: VisibleRepository;
  /**
   * **開く手続きごと受ける**（`listVisibleRepositories` と同じ形）。
   * **開いた結果だけを受けると、開く手前で落ちたときにここへ入らない。**
   */
  readonly openStore: () => Promise<UserTokenStore | undefined>;
  readonly ensure: (store: UserTokenStore) => Promise<UsableToken>;
  /** **そのユーザーの目**。**見てよいかは、これだけで決める。** */
  readonly repositories: VisibleRepositories;
  /**
   * 盤面を組み立てる手続き。**installation トークンを使う側**である。
   *
   * **手続きごと受けるのは、「見てよい」と分かるまで 1 度も呼ばないため**——
   * **結果を受け取る形にすると、確かめる前に取りに行くことになる。**
   */
  readonly plan: () => Promise<ReviewOrderPlan>;
};

export async function viewRepositoryBoard({
  repository,
  openStore,
  ensure,
  repositories,
  plan,
}: ViewRepositoryBoardInput): Promise<RepositoryBoardResult> {
  // **認可は共有の判断が持つ** (#315)。**ここへ写すと、Approve / Merge 側と
  // 片方だけ直したときに食い違う**——**症状は「他人のものが見える / 触れる」**である。
  const authorization = await authorizeRepository({ repository, openStore, ensure, repositories });
  if (authorization.kind !== "authorized") {
    return authorization;
  }

  try {
    return { kind: "board", plan: await plan() };
  } catch {
    // **`planReviewOrder` は一覧を取れないと投げる**（**空の計画にすると
    // 「取得できなかった」が「PR が 0 件」に化ける**ため）——**そのまま通すと、
    // 見てよい人にまでフレームワークのエラー画面が出て、
    // 用意してある「読み込み直してください」へ届かない**（#316 のレビュー）。
    //
    // **`not-found` へは倒さない。** **ここへ来た時点で「見える」と分かっている**
    // ので、**故障を「ありません」に化けさせる理由が無い。**
    return { kind: "unavailable" };
  }
}
