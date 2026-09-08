/**
 * **どれから見るかを、理由つきで出す**（#632）。
 *
 * **盤面の一覧とは別に出す。** **一覧は依存の順のまま**である
 * ——**混ぜて 1 つの並びにすると、「急ぐべき PR が先に見える」せいで、
 * 土台より先に積み荷をマージしようとする**（`review-board.tsx` の判断）。
 * **画面でも、そう書く**（**並びだけ見せると、読む側が混ぜる**）。
 *
 * **判定はしない**（`RiskTierView` と同じ）。**材料を受け取って
 * `suggestReviewOrder` に渡す**——**並びを渡させると、材料と食い違ったものを
 * 渡せてしまう。**
 */

import type { PullRequestRef } from "../../domain/graph/dependency-graph";
import type { DependencyOrder } from "../../domain/graph/dependency-order";
import type { MergeStatusReport } from "../../domain/graph/merge-readiness";
import { mergeReadinessOf } from "../../domain/graph/merge-readiness";
import type { ReviewReason } from "../../domain/triage/review-priority";
import { suggestReviewOrder } from "../../domain/triage/review-priority";
import type { ChangeSummary } from "../../domain/triage/risk-tier";

/**
 * **なぜその順なのか。**
 *
 * **`Record` で持つ**（`TIER_TEXT` と同じ形）——**理由が増えた日に書き忘れると
 * 型検査が落ちる**ので、**名前も出ないまま画面に出ることが起きない。**
 *
 * **Tier の札とは別の文にする。** **札は「その PR がどれだけ危ないか」**で、
 * **ここは「なぜこの順で見るか」**である。
 */
const REASON_TEXT: Record<ReviewReason, string> = {
  "high-risk": "読む時間が要ります",
  "needs-review": "いつもどおり読むものです",
  "fast-track": "短時間で片付きます",
  unknown: "判定の材料がありません",
  "needs-author": "著者の手が要ります（conflict・下書き・CI）",
};

/** その行に出す 1 文。 */
export function reviewReasonNote(reason: ReviewReason): string {
  return REASON_TEXT[reason];
}

export type SuggestedReviewOrderProps = {
  /** **盤面に出ている PR ぜんぶ**。**並べ替えであって、絞り込みではない。** */
  readonly pullRequests: readonly PullRequestRef[];
  /**
   * 依存の順序。**同じ理由のものを並べる、最後の手掛かり**である
   * ——**マージ順そのものではない**（そちらは図と Merge ボタンが持つ）。
   */
  readonly order: DependencyOrder;
  /** PR 番号から引ける判定材料。**取れていない PR は入らない。** */
  readonly changes: ReadonlyMap<number, ChangeSummary>;
  /** **その PR の合流の状況**（#629）。**取れていないなら `undefined`。** */
  readonly mergeStatusOf: (pullRequestNumber: number) => MergeStatusReport | undefined;
  /** **その PR のタイトル**（#542）。**取れていないなら `undefined`。** */
  readonly titleOf: (pullRequestNumber: number) => string | undefined;
  /** **その PR の GitHub 上の場所**（#621）。 */
  readonly urlOf: (pullRequestNumber: number) => string;
};

export function SuggestedReviewOrder({
  pullRequests,
  order,
  changes,
  mergeStatusOf,
  titleOf,
  urlOf,
}: SuggestedReviewOrderProps) {
  // **1 件も無ければ、見出しごと出さない**——**空の一覧は、壊れているのか
  // 空なのかが読めない**（`DependencyGraphView` と同じ判断）
  if (pullRequests.length === 0) {
    return undefined;
  }

  const suggestions = suggestReviewOrder(
    pullRequests.map((pullRequest) => ({
      number: pullRequest.number,
      change: changes.get(pullRequest.number),
      readiness: mergeReadinessOf(mergeStatusOf(pullRequest.number)),
    })),
    order,
  );

  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-semibold">推奨レビュー順</h2>
      {/* **マージの順序と混ぜて読ませない**——**守らないと壊れるのは依存の側だけ**である */}
      <p className="text-sm opacity-70">
        時間の使い方の目安です。マージできる順は、下の図と Merge ボタンが持っています。
      </p>
      <ol className="flex flex-col gap-1">
        {suggestions.map((suggestion) => (
          <li className="flex flex-wrap items-baseline gap-2 text-sm" key={suggestion.number}>
            {/* **番号とタイトルを 1 つのリンクにする**（#621 と同じ形） */}
            <a className="font-mono font-bold underline" href={urlOf(suggestion.number)}>
              #{suggestion.number}
              {titleOf(suggestion.number) === undefined ? "" : ` ${titleOf(suggestion.number)}`}
            </a>
            <span className="opacity-70">{reviewReasonNote(suggestion.reason)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
