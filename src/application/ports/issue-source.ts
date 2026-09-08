/**
 * issue の一覧を取ってくる口（#633）。
 *
 * **検証済みのものだけを内側へ入れる**（`pull-request-source` と同じ契約）。
 * 応答の形も検証ライブラリも知るのは境界（infrastructure）だけである。
 *
 * **PR の口と分けてある。** **GitHub の `GET /issues` は PR も返す**が、
 * **それは境界の都合**であって、**内側に「PR でもある issue」を持ち込まない。**
 */

import type { IssueAssignment, IssueRef } from "../../domain/triage/issue";

/** 検証に落ちた 1 件。 */
export type InvalidIssue = {
  /**
   * 応答の何件目か（0 始まり）。**番号ではなく位置で示す**のは、
   * 番号そのものが読めないことがあるためである。
   */
  readonly index: number;
  /** 何が読めなかったか。 */
  readonly reason: string;
};

/**
 * 取ってきた一覧。
 *
 * **落ちたものを黙って捨てない**（`PullRequestListing` と同じ理由）——**捨てると
 * 「取得できたが読めなかった」と「そもそも無かった」が区別できない。**
 */
export type IssueListing = {
  readonly issues: readonly IssueRef[];
  readonly invalid: readonly InvalidIssue[];
  /**
   * issue 番号から引ける、誰に振られているか。
   *
   * **読めなかったものは入らない。** **`issueAssignmentStateOf` が地図に無い番号を
   * `unknown` へ倒す**ので、**「読めなかった」が「誰も持っていない」に化けない**
   * （`AGENTS.md` §5）。
   *
   * **`IssueRef` へ足さない**——**あれは「どの issue か」を言うのに要る最小限**である。
   */
  readonly assignments: ReadonlyMap<number, IssueAssignment>;
};

/** 取得のしかたに関する指示（`ChangeSummaryRequest` と同じ形）。 */
export type IssueRequest = {
  /**
   * 打ち切りの合図。
   *
   * **先に返すだけでは、走っている要求は走り続ける。** 取り消しを**口まで通さない**と、
   * **縮退したのは呼んだ側だけ**で、往復は最後まで続く。
   *
   * **期限の決め方はここに無い。** どれだけ待つかは**呼ぶ側の段取り**であって、
   * ユースケースの判断ではない（`application` は時計を持たない）。
   */
  readonly signal?: AbortSignal;
};

export type IssueSource = {
  /**
   * open な issue を、最後のページまで読む。**読み切れなければ投げる。**
   *
   * **合図を受けたら速やかに返る**——ただし**呼ぶ側はこの約束に頼らない**
   * （守らない実装でも、呼ぶ側は待ち続けない）。
   */
  listIssues(request?: IssueRequest): Promise<IssueListing>;
};
