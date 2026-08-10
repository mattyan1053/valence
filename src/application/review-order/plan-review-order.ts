/**
 * 「PR 一覧を取ってきて、依存グラフと順序を出す」流れ。
 *
 * **UI も通信もこの流れを呼ぶ側になる。** 先に決めておかないと、双方が別々の形を作る。
 * ここが知っているのは **port と domain だけ**で、GitHub も検証ライブラリも知らない。
 */

import type { DependencyEdge, PullRequestRef } from "../../domain/graph/dependency-graph";
import { buildDependencyEdges } from "../../domain/graph/dependency-graph";
import type { DependencyOrder } from "../../domain/graph/dependency-order";
import { orderByDependency } from "../../domain/graph/dependency-order";
import type { ChangeSummary } from "../../domain/triage/risk-tier";
import type { ChangeSummarySource, UnavailableChangeSummary } from "../ports/change-summary-source";
import type { InvalidPullRequest, PullRequestSource } from "../ports/pull-request-source";

/**
 * レビューの交通整理に要るもの一式。
 *
 * **辺と順序を両方返す。** 描画は辺を、並べ替えは順序を使うので、どちらかに
 * 寄せると呼び出し側が同じ計算をやり直すことになる。
 */
export type ReviewOrderPlan = {
  readonly pullRequests: readonly PullRequestRef[];
  readonly edges: readonly DependencyEdge[];
  readonly order: DependencyOrder;
  /** 読めなかった PR。**0 件でないなら、この図には抜けがある。** */
  readonly invalid: readonly InvalidPullRequest[];
  /** PR 番号から引けるリスク判定の材料。**取れなかった PR は入らない。** */
  readonly changes: ReadonlyMap<number, ChangeSummary>;
  /** 材料を取れなかった PR。**0 件でないなら、その行は Tier を出せない。** */
  readonly changesUnavailable: readonly UnavailableChangeSummary[];
};

export type ReviewOrderSources = {
  readonly pullRequests: PullRequestSource;
  readonly changes: ChangeSummarySource;
};

/**
 * 一覧を取り、依存グラフと順序を組み立てる。
 *
 * **取得の失敗は投げたまま通す。** 結果に載せると、空の計画と同じ型になり、
 * **「取得できなかった」が「PR が 0 件」に化ける**。呼び出し側は例外の有無で
 * 区別できる。
 */
export async function planReviewOrder(sources: ReviewOrderSources): Promise<ReviewOrderPlan> {
  const { pullRequests, invalid } = await sources.pullRequests.listPullRequests();
  const edges = buildDependencyEdges(pullRequests);
  const numbers = pullRequests.map((pullRequest) => pullRequest.number);
  const changes = await collectChanges(sources.changes, numbers);

  return {
    pullRequests,
    edges,
    order: orderByDependency(pullRequests, edges),
    invalid,
    ...changes,
  };
}

/**
 * 材料を集める。**丸ごと落ちても投げない。**
 *
 * **一覧の取得とは扱いを変えている。** 一覧が落ちたら投げる——結果に載せると
 * **「取得できなかった」が「PR が 0 件」に化ける**（このファイルの上のコメント）。
 * **材料は化けない。** 取れなかった PR の行は残り、画面は「材料がありません」と出す
 * ので、**「無い」ではなく「読めなかった」と読める**（#112 / #117）。そして
 * **依存グラフだけでも交通整理の役に立つ**ので、材料のために画面ごと落とさない。
 *
 * **黙って捨てもしない。** 空の地図だけだと、**1 件も材料が無いのか、口が壊れているのか**
 * が区別できない。**丸ごと落ちたときは、全 PR を理由つきで `unavailable` に載せる。**
 */
async function collectChanges(
  source: ChangeSummarySource,
  numbers: readonly number[],
): Promise<Pick<ReviewOrderPlan, "changes" | "changesUnavailable">> {
  try {
    const listing = await source.listChangeSummaries(numbers);
    return { changes: listing.summaries, changesUnavailable: listing.unavailable };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "材料を取得できませんでした";
    return {
      changes: new Map(),
      changesUnavailable: numbers.map((pullRequestNumber) => ({ pullRequestNumber, reason })),
    };
  }
}
