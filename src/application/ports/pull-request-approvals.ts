/**
 * **PR が承認済みかどうかを読む口**（#343）。
 *
 * **書く側（`PullRequestReviews`）とは別に置く。** **出すのと読むのは、
 * 呼ばれる場面も、失敗したときの倒し方も違う**——**承認は 1 度きりの操作**で、
 * **状態は盤面を描くたびに引く。** **同じ型に混ぜると、「押せなかった」と
 * 「読めなかった」が 1 つの語彙に集まる。**
 *
 * **読むのもユーザートークンである**（`AGENTS.md` §6）。**installation トークンで
 * 代用しない**——**あれは「リポジトリへの操作」**なので、**誰がログインしていても
 * 同じ答えになる。**
 *
 * **「承認されていない」と「読めなかった」を分ける**（#112 と同じ形）。
 * **読めなかったものを `approved` から外すだけにすると、画面では
 * 「承認されていない」と見分けが付かない**——**押した人は、もう一度押す。**
 */

import type { VisibleRepository } from "./visible-repositories";

/** 状態を読めなかった 1 件。**「承認されていない」ではない。** */
export type UnavailableApproval = {
  readonly pullRequestNumber: number;
  /** **「承認されていない」ではなく「見ていない」**ことが分かる文言を入れる。 */
  readonly reason: string;
};

export type PullRequestApprovalListing = {
  /**
   * **承認済みと確かめられた PR の番号。**
   *
   * **確かめられたものだけを入れる。** **迷ったら入れない**——
   * **「承認済み」は取り消せない事実の主張**で、**見た人はマージへ進む**
   * （#342 が `?approve=approved` を塞いだのと同じ向き）。
   */
  readonly approved: ReadonlySet<number>;
  /** 読めなかった PR。**0 件でないなら、その行の承認状態は分からない。** */
  readonly unavailable: readonly UnavailableApproval[];
};

/** 取得のしかたに関する指示。**`ChangeSummaryRequest` と同じ形**である。 */
export type PullRequestApprovalRequest = {
  /**
   * 打ち切りの合図（#346 のレビュー）。
   *
   * **先に返すだけでは、走っている要求は走り続ける。** **取り消しを口まで
   * 通さない**と、**縮退したのは呼んだ側だけ**で、往復は最後まで続く。
   *
   * **期限の決め方はここに無い。** どれだけ待つかは**呼ぶ側の段取り**であって、
   * ユースケースの判断ではない（`application` は時計を持たない）。
   */
  readonly signal?: AbortSignal;
};

export type PullRequestApprovals = {
  /**
   * **その人の身元で**、承認の状態を読む。
   *
   * **判定を写さない**（§5）。**「最新の意見だけを数える」「取り下げられた承認は
   * 数えない」といった規則は GitHub が持っている**——**こちらで数え直すと、
   * 向こうが変わったときに片方だけ古くなる**（**症状は「承認されているのに
   * 出ない / されていないのに出る」**）。
   *
   * **落ちたら投げる。** **空の一覧を返すと、「読めなかった」が
   * 「1 件も承認されていない」に化ける**——**呼ぶ側が理由つきで残す。**
   */
  listApprovals(
    userAccessToken: string,
    repository: VisibleRepository,
    pullRequestNumbers: readonly number[],
    request?: PullRequestApprovalRequest,
  ): Promise<PullRequestApprovalListing>;
};
