/**
 * **どれから見るかを、理由つきで出す**（#632）。
 *
 * **「マージ順」と「レビュー順」は別である。** **マージ順は依存が決める**
 * ——**守らないと壊れる**（`MergeBlock` / `DependencyOrder`）。**レビュー順は
 * 人の時間の使い方**で、**守らなくても壊れない。**
 *
 * **だから、ここは並びを 1 つにまとめない。** **盤面の一覧は依存の順のまま**で、
 * **これは別に出す**——**混ぜると「急ぐべき PR が先に見える」せいで、
 * 土台より先に積み荷をマージしようとする**（`review-board.tsx` の判断）。
 *
 * **理由を返す。** **順番だけ出しても、なぜその順かが追えない**
 * ——**ルールベースであることの価値は、判定を検算できること**にある（`RiskTierView`）。
 *
 * **純粋関数である**（§3）。**材料をどこから取るかは、この層の関心ではない。**
 */

import type { DependencyOrder } from "../graph/dependency-order";
import type { MergeReadiness } from "../graph/merge-readiness";
import type { ChangeSummary } from "./risk-tier";
import { classifyRiskTier } from "./risk-tier";

/**
 * 並べ替えの材料 1 件ぶん。
 *
 * **Tier ではなく材料を受け取る**（`ReviewBoardProps.changes` と同じ理由）
 * ——**Tier を渡させると、材料と食い違ったものを渡せてしまう。**
 */
export type ReviewCandidate = {
  readonly number: number;
  /** リスク判定の材料。**取れていないなら `undefined`。** */
  readonly change: ChangeSummary | undefined;
  /** 合流の状況（#629）。**「押せない理由」は、見る順にも効く。** */
  readonly readiness: MergeReadiness;
};

/**
 * **なぜその順なのか。**
 *
 * **Tier の名前をそのまま使う**（`high-risk` / `needs-review` / `fast-track`）
 * ——**画面には既に同じ札が出ている**ので、**別の語を作ると、同じことを 2 つの
 * 語彙で言うことになる。**
 */
export type ReviewReason =
  /** **時間が要る。** 札は「先に人が見る」である。 */
  | "high-risk"
  /** **いつもどおり読む。** */
  | "needs-review"
  /** **短時間で片付く。** */
  | "fast-track"
  /** **材料が無いので、決められない。** */
  | "unknown"
  /**
   * **著者の手が要る。**
   *
   * **conflict・下書き・base の遅れ・CI が落ちている**が入る。**いま読んでも
   * 手戻りする**ので、**後ろへ回す**（#632 の完了条件）。
   *
   * **`behind` が入るのは、勧めた結果が確実に捨てられるから**である
   * （#648 のレビュー）——**`BEHIND` が返るのは最新化を必須にしているリポジトリ**
   * （#644 で測った）**なので、著者は base を取り込むしかなく**、
   * **取り込めば head が変わり、そこまでの承認は消える**（#643）。
   *
   * **保護ルールで止まっている（`blocked`）は入らない**——**未解決スレッドや
   * 承認の不足**は、**レビュアーを待っている側**である。**切る軸は
   * 「次に動くのが誰か」**であって、「押せるかどうか」ではない。
   */
  | "needs-author";

export type ReviewSuggestion = {
  readonly number: number;
  readonly reason: ReviewReason;
};

/**
 * 理由ごとの並び。**小さいほど先に見る。**
 *
 * **`Record` で持つ**（`READINESS_OF_STATE` と同じ形）——**理由が増えた日に
 * 型検査が落ちる**ので、**順位を決めずには通らない。**
 */
const RANK: Record<ReviewReason, number> = {
  "high-risk": 0,
  "needs-review": 1,
  "fast-track": 2,
  unknown: 3,
  "needs-author": 4,
};

/**
 * **見る順を返す。** **1 件も落とさない**——**並べ替えであって、絞り込みではない。**
 *
 * **同じ理由のものは、依存の順のまま**（`order.ordered`）。**土台を先に見たほうが、
 * 上に積まれたものが早く進む**——**ただしこれは最後の手掛かり**であって、
 * **理由より先には効かない。** **依存の順に出てこないもの**（循環に居るもの・
 * 順序に出ないもの）**は、その後ろ**に置く（**落とさない**）。
 */
export function suggestReviewOrder(
  candidates: readonly ReviewCandidate[],
  order: DependencyOrder,
): readonly ReviewSuggestion[] {
  const dependencyRank = new Map(order.ordered.map((number, index) => [number, index]));
  // **依存の順に出てこないものは、いちばん後ろ**（**同じ理由の中で、順序に出たものの後**）
  const last = order.ordered.length;

  return candidates
    .map((candidate, index) => ({
      suggestion: { number: candidate.number, reason: reasonFor(candidate) },
      dependency: dependencyRank.get(candidate.number) ?? last,
      // **並びを安定させる**（**入力の順を最後の手掛かりにする**）
      index,
    }))
    .sort(
      (left, right) =>
        RANK[left.suggestion.reason] - RANK[right.suggestion.reason] ||
        left.dependency - right.dependency ||
        left.index - right.index,
    )
    .map((row) => row.suggestion);
}

/**
 * その PR を、いま見てよいか。
 *
 * **著者待ちを先に見る。** **CI が落ちていると `classifyRiskTier` は `high-risk` を
 * 返す**ので、**そのまま並べると、直っていないものが先頭に来る。**
 *
 * **合流の状況が分からない（`unknown`）ものは、後ろへ回さない**——**GitHub が
 * 計算中の間ずっと全部が後ろへ行くと、この並びは何も言わなくなる。**
 * **外れても手戻りは 1 件ぶん**である（**マージを止めるのは `MergeBlock` の側**）。
 *
 * **全部が `behind` になる設定でも害は無い**（#648 のレビュー）——**同じ束の中で
 * 相対順は保たれる。**
 */
const AUTHOR_FIRST: ReadonlySet<MergeReadiness["kind"]> = new Set([
  "conflicting",
  "draft",
  // **取り込めば head が変わり、そこまでの承認は消える**（#643。#648 のレビュー）
  "behind",
]);

function reasonFor({ change, readiness }: ReviewCandidate): ReviewReason {
  if (AUTHOR_FIRST.has(readiness.kind)) {
    return "needs-author";
  }
  if (change === undefined) {
    return "unknown";
  }
  if (change.ciStatus === "failing") {
    return "needs-author";
  }
  return classifyRiskTier(change);
}
