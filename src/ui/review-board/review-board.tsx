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

import type { ReactNode } from "react";
import type { DependencyEdge, PullRequestRef } from "../../domain/graph/dependency-graph";
import type { DependencyOrder } from "../../domain/graph/dependency-order";
import type { ChangeSummary } from "../../domain/triage/risk-tier";
import { classifyRiskTier } from "../../domain/triage/risk-tier";
import type { UnreadablePullRequest } from "../dependency-graph/dependency-graph-view";
import { DependencyGraphView } from "../dependency-graph/dependency-graph-view";
import { RiskTierView } from "../risk-tier/risk-tier-view";

/**
 * **材料が無い理由を、画面の語彙にする**（#573）。
 *
 * **3 つを 1 つの文にしていた**——**打ち切った / 読めなかった / 本当に材料が無い。**
 * **利用者に見えたのは全 PR で同じ 1 文**で、**どれなのかはどこにも残らなかった。**
 *
 * **実測（2026-09-02）**: **取得は成功していて 5627 ms**、**期限は 5000 ms**
 * ——**毎回打ち切られていた。** **「取れなかった」ではなく「待たなかった」**である。
 * **同じ文言だと、権限を疑いに行く**（**実際にそうなった**）。
 *
 * **知らない語でも黙らない。** **語彙が増えた日に行が消えると、また同じ顔になる。**
 */
export function changeUnavailableNote(kind: string): string {
  switch (kind) {
    case "timedout":
      // **待たなかったのであって、取れなかったのではない**
      return "リスク判定の材料が、時間内に返りませんでした";
    case "unreadable":
      return "リスク判定の材料を読めませんでした";
    default:
      // **語彙が増えても、行は残す**——**理由は記録の側にある**
      return `リスク判定の材料がありません（${kind}）`;
  }
}

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
  /**
   * **材料が無い理由**（#573）。**PR 番号から `kind` を引く**。
   *
   * **受けるのは `kind` だけ**である——**`reason` には応答の値が入りうる**
   * （`AGENTS.md` §6。#506 と同じ判断）。**判定の語彙は `application` の側にあるが、
   * ここは文字列として受ける**（**`ui` は `application` を import できない**）。
   */
  readonly changeUnavailableOf?: (number: number) => string | undefined;
  /**
   * 各行へ足す操作（#330）。
   *
   * **並びを作り直さないための口**である（`renderAside` と同じ理由）——
   * **操作を足すために行を組み立て直すと、画面から PR が消える穴が復活する。**
   *
   * **任意にしてよい。** **渡さなければ操作が出ないだけ**で、
   * **「抜けが無い」と言い切る類の値ではない**（`invalid` とは違う）。
   */
  readonly renderActions?: (pullRequestNumber: number) => ReactNode;
  /**
   * 各行へ足す**状態の表示**（#343）。
   *
   * **操作（`renderActions`）と分ける。** **押すものと、押した結果として出るものは
   * 別**である——**混ぜると、状態を足すたびに操作の口を触ることになる。**
   *
   * **任意にしてよい。** **渡さなければ出ないだけ**で、
   * **「抜けが無い」と言い切る類の値ではない**（`invalid` とは違う）。
   */
  readonly renderStatus?: (pullRequestNumber: number) => ReactNode;
  /**
   * **その PR の head の commit が分かっているか**（#541 のレビュー）。
   *
   * **盤面はこれを持っていない**（`changes` は判定材料で、commit ではない）ので、
   * **渡す側から受ける**——**`MergeButton` へ渡している `headSha` と、同じもの**である。
   *
   * **任意にしない。** **どちらへ倒しても嘘になる**（`NodeMark.headKnown`）。
   */
  readonly headKnown: (pullRequestNumber: number) => boolean;
  /**
   * **その PR のタイトル**（#542）。**取れていないなら `undefined`。**
   *
   * **盤面はこれを持っていない**（`changes` は判定材料である）ので、**渡す側から受ける。**
   *
   * **任意にしない。** **渡し忘れると、どの箱も「タイトル不明」になる**
   * ——**取れているのに取れていないと言う**（`NodeMark.title`）。
   */
  readonly titleOf: (pullRequestNumber: number) => string | undefined;
};

export function ReviewBoard({
  pullRequests,
  edges,
  order,
  invalid,
  changes,
  changeUnavailableOf,
  renderActions,
  renderStatus,
  headKnown,
  titleOf,
}: ReviewBoardProps) {
  return (
    <DependencyGraphView
      pullRequests={pullRequests}
      edges={edges}
      order={order}
      invalid={invalid}
      // **図の箱にも危なさを載せる**（#540）。**脇の文章にしか無いと、
      // 10 本並んだとき全部読むまで順番が決まらない**——**判定は同じ
      // `classifyRiskTier`** なので、**箱と脇で食い違わない。**
      tierOf={(number) => {
        const change = changes.get(number);
        // **材料が無いことを「危なくない」に倒さない**（下の行と同じ判断）
        return change === undefined ? undefined : classifyRiskTier(change);
      }}
      headKnown={headKnown}
      titleOf={titleOf}
      renderAside={(number) => {
        const change = changes.get(number);
        // **材料が無い PR を黙って落とさない。** 行は残し、
        // 「出せなかった」ことが分かる形にする（#107 の `invalid` と同じ形）。
        if (change === undefined) {
          const kind = changeUnavailableOf?.(number);
          // **材料が無くても操作は出す。** **Tier は目安**であって、
          // **承認してよいかの判断ではない**——**揃うまで押せないのは、
          // 交通整理をしに来た人を待たせるだけである**
          return (
            <>
              <span>
                {kind === undefined
                  ? // **本当に材料が無い**（**取りに行った跡が無い**）
                    "リスク判定の材料がありません（まだ取得できていません）"
                  : changeUnavailableNote(kind)}
              </span>
              {renderStatus?.(number)}
              {renderActions?.(number)}
            </>
          );
        }
        return (
          <>
            <RiskTierView tier={classifyRiskTier(change)} change={change} />
            {renderStatus?.(number)}
            {renderActions?.(number)}
          </>
        );
      }}
    />
  );
}
