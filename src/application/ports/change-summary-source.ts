/**
 * リスク判定の材料を取ってくる口。
 *
 * **取れなかった PR を落とさない。** 画面は「材料が無い PR も行は残る」形になっている
 * （#112）ので、**取れなかったものは地図に入れず、理由だけ残す**。例外で全体を落とすと、
 * **1 本の失敗で画面が真っ白になる**。
 */

import type { ChangeSummary } from "../../domain/triage/risk-tier";

/** 材料を組み立てられなかった 1 件。 */
export type UnavailableChangeSummary = {
  readonly pullRequestNumber: number;
  /** **「触れていない」ではなく「見ていない」**ことが分かる文言を入れる。 */
  readonly reason: string;
};

export type ChangeSummaryListing = {
  /** 番号から引ける材料。**取れなかった PR は入らない。** */
  readonly summaries: ReadonlyMap<number, ChangeSummary>;
  readonly unavailable: readonly UnavailableChangeSummary[];
};

export type ChangeSummarySource = {
  /**
   * 指定した PR の材料を取る。
   *
   * **1 本の失敗で全体を落とさない。** 取れたものは返し、取れなかったものは
   * `unavailable` に残す。
   */
  listChangeSummaries(pullRequestNumbers: readonly number[]): Promise<ChangeSummaryListing>;
};
