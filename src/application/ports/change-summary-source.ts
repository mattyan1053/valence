/**
 * リスク判定の材料を取ってくる口。
 *
 * **取れなかった PR を落とさない。** 画面は「材料が無い PR も行は残る」形になっている
 * （#112）ので、**取れなかったものは地図に入れず、理由だけ残す**。例外で全体を落とすと、
 * **1 本の失敗で画面が真っ白になる**。
 */

import type { ChangeSummary } from "../../domain/triage/risk-tier";

/**
 * 材料が無かった理由の**種別**。
 *
 * **文言で見分けさせない。** 読む側が文字列を解釈する形にすると、**言い換えた瞬間に
 * 区別が消える**。**#112 以降ずっと分けてきた「読めなかった / 無かった」**を、
 * **縮退の実装そのもので潰さない**ため、型に載せてある。
 *
 *   unreadable … 取りに行って読めなかった（落ちた・形が違う）
 *   timedout   … **間に合わなかった**（取りに行ったが、期限までに返らなかった）
 */
export type UnavailableReasonKind = "unreadable" | "timedout";

/** 材料を組み立てられなかった 1 件。 */
export type UnavailableChangeSummary = {
  readonly pullRequestNumber: number;
  readonly kind: UnavailableReasonKind;
  /** **「触れていない」ではなく「見ていない」**ことが分かる文言を入れる。 */
  readonly reason: string;
};

export type ChangeSummaryListing = {
  /** 番号から引ける材料。**取れなかった PR は入らない。** */
  readonly summaries: ReadonlyMap<number, ChangeSummary>;
  readonly unavailable: readonly UnavailableChangeSummary[];
};

/** 取得のしかたに関する指示。 */
export type ChangeSummaryRequest = {
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

export type ChangeSummarySource = {
  /**
   * 指定した PR の材料を取る。
   *
   * **1 本の失敗で全体を落とさない。** 取れたものは返し、取れなかったものは
   * `unavailable` に残す。
   *
   * **合図を受けたら、取れたぶんを持って速やかに返す。** 途中まで取れているものを
   * 捨てないため——ただし**呼ぶ側はこの約束に頼らない**（守らない実装でも、
   * 呼ぶ側は待ち続けない）。
   */
  listChangeSummaries(
    pullRequestNumbers: readonly number[],
    request?: ChangeSummaryRequest,
  ): Promise<ChangeSummaryListing>;
};
