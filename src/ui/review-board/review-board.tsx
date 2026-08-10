/**
 * レビュアーが見る画面。**依存の順に並べ、各行にリスク Tier を載せる。**
 *
 * 部品は既にある（#107 の依存グラフ、#110 のリスク Tier）。**ここは合成だけで、
 * どちらも作り直さない。** 並びの持ち主は依存グラフのほうなので、行を組み立て直さず
 * その口（`renderAside`）へ載せる。
 *
 * **Tier で並べ替えない。** 依存の順は**守らないとマージできない制約**で、
 * Tier は**優先度の目安**でしかない。混ぜると「急ぐべき PR が先に見える」せいで
 * **土台より先に積み荷をマージしようとする**——このプロダクトが解こうとしている問題を、
 * 画面が作り出すことになる。
 */

import type { DependencyEdge, PullRequestRef } from "../../domain/graph/dependency-graph";
import type { DependencyOrder } from "../../domain/graph/dependency-order";
import type { ChangeSummary } from "../../domain/triage/risk-tier";
import { classifyRiskTier } from "../../domain/triage/risk-tier";
import type { UnreadablePullRequest } from "../dependency-graph/dependency-graph-view";
import { DependencyGraphView } from "../dependency-graph/dependency-graph-view";
import { RiskTierView } from "../risk-tier/risk-tier-view";

export type ReviewBoardProps = {
  readonly pullRequests: readonly PullRequestRef[];
  readonly edges: readonly DependencyEdge[];
  readonly order: DependencyOrder;
  readonly invalid: readonly UnreadablePullRequest[];
  /**
   * PR 番号から引ける判定材料。
   *
   * **Tier ではなく材料を受け取る。** Tier を渡させると、**材料と食い違ったものを
   * 渡せてしまう**（#110 のレビューで実際に問題になった形）。判定は
   * `classifyRiskTier` に任せるので、**画面の中で理由が食い違わない**。
   *
   * **揃っていない PR があってよい。** 取得はこの層の仕事ではなく、
   * 揃うまでの間も画面は出る。
   */
  readonly changes: ReadonlyMap<number, ChangeSummary>;
};

export function ReviewBoard({ pullRequests, edges, order, invalid, changes }: ReviewBoardProps) {
  return (
    <DependencyGraphView
      pullRequests={pullRequests}
      edges={edges}
      order={order}
      invalid={invalid}
      renderAside={(number) => {
        const change = changes.get(number);
        // **材料が無い PR を黙って落とさない。** 行は残し、
        // 「出せなかった」ことが分かる形にする（#107 の `invalid` と同じ形）。
        if (change === undefined) {
          return <span>リスク判定の材料がありません（まだ取得できていません）</span>;
        }
        return <RiskTierView tier={classifyRiskTier(change)} change={change} />;
      }}
    />
  );
}
