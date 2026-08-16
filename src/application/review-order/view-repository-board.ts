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
import type {
  PullRequestApprovalListing,
  PullRequestApprovals,
} from "../ports/pull-request-approvals";
import type { RepositoryPermissions } from "../ports/repository-permissions";
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
  | {
      readonly kind: "board";
      readonly plan: ReviewOrderPlan;
      /**
       * **各 PR が承認済みかどうか**（#343）。
       *
       * **押した結果は、盤面そのもので確かめる**——**成功はクエリ文字列に
       * 載らない**（#342 のレビュー）ので、**ここが唯一の手掛かり**である。
       */
      readonly approvals: PullRequestApprovalListing;
    };

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
   * **読むだけなので、ここでは引かれない** (#317 のレビュー)。
   *
   * **盤面に `write` を要求しない**——**read-only の人が見られなくなり、
   * 「レビュアー側の交通整理」そのものが壊れる**（§1）。
   */
  readonly permissions: RepositoryPermissions;
  /**
   * 盤面を組み立てる手続き。**installation トークンを使う側**である。
   *
   * **手続きごと受けるのは、「見てよい」と分かるまで 1 度も呼ばないため**——
   * **結果を受け取る形にすると、確かめる前に取りに行くことになる。**
   */
  readonly plan: () => Promise<ReviewOrderPlan>;
  /**
   * **承認の状態を読む口**（#343）。**ユーザートークンで読む側**である（§6）。
   *
   * **任意にしない。** **渡さなければ出ないだけ、にすると、
   * 合成ルートで渡し忘れた日から「押した結果が出ない」へ静かに戻る**
   * ——**#343 が消しに来た状態**である。
   */
  readonly approvals: PullRequestApprovals;
};

export async function viewRepositoryBoard({
  repository,
  openStore,
  ensure,
  repositories,
  permissions,
  plan,
  approvals,
}: ViewRepositoryBoardInput): Promise<RepositoryBoardResult> {
  // **認可は共有の判断が持つ** (#315)。**ここへ写すと、Approve / Merge 側と
  // 片方だけ直したときに食い違う**——**症状は「他人のものが見える / 触れる」**である。
  const authorization = await authorizeRepository({
    repository,
    openStore,
    ensure,
    repositories,
    permissions,
    // **見るだけなので `read`。** **`write` にすると read-only の人が締め出される**
    require: "read",
  });
  if (authorization.kind !== "authorized") {
    // **`forbidden` は read では起きない**（引かないので）——**型のために並べる**
    return authorization.kind === "forbidden" ? { kind: "unavailable" } : authorization;
  }

  let board: ReviewOrderPlan;
  try {
    board = await plan();
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

  return {
    kind: "board",
    plan: board,
    approvals: await readApprovals(
      approvals,
      authorization.userAccessToken,
      repository,
      board.pullRequests.map((pullRequest) => pullRequest.number),
    ),
  };
}

/**
 * 承認の状態を読む。**落ちても盤面は返す。**
 *
 * **依存グラフだけでも交通整理の役に立つ**（`planReviewOrder` の `collectChanges` と
 * 同じ判断）——**状態が読めないことを理由に、画面ごと落とさない。**
 *
 * **黙って捨てない。** **`approved` から外すだけだと、画面では
 * 「承認されていない」と見分けが付かない**——**押した人はもう一度押す**
 * （**#343 が消しに来た形そのもの**）。**理由つきで残す。**
 */
async function readApprovals(
  approvals: PullRequestApprovals,
  userAccessToken: string,
  repository: VisibleRepository,
  numbers: readonly number[],
): Promise<PullRequestApprovalListing> {
  // **読むものが無ければ、往復も作らない**
  if (numbers.length === 0) {
    return { approved: new Set(), unavailable: [] };
  }
  try {
    return await approvals.listApprovals(userAccessToken, repository, numbers);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "承認の状態を取得できませんでした";
    return {
      approved: new Set(),
      unavailable: numbers.map((pullRequestNumber) => ({ pullRequestNumber, reason })),
    };
  }
}
