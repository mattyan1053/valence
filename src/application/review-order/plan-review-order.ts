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
import type { InvalidPullRequest, PullRequestMapper } from "../ports/pull-request-mapper";
import type { PullRequestSource } from "../ports/pull-request-source";

/** ユースケースが要る口。差し替えるのは合成ルートの仕事。 */
export type ReviewOrderDependencies = {
  readonly source: PullRequestSource;
  readonly mapper: PullRequestMapper;
};

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
};

/**
 * 一覧を取り、依存グラフと順序を組み立てる。
 *
 * **取得の失敗は投げたまま通す。** 結果に載せると、空の計画と同じ型になり、
 * **「取得できなかった」が「PR が 0 件」に化ける**。呼び出し側は例外の有無で
 * 区別できる。
 */
export async function planReviewOrder({
  source,
  mapper,
}: ReviewOrderDependencies): Promise<ReviewOrderPlan> {
  const response = await source.listPullRequests();
  const { pullRequests, invalid } = mapper(response);
  const edges = buildDependencyEdges(pullRequests);
  return { pullRequests, edges, order: orderByDependency(pullRequests, edges), invalid };
}
