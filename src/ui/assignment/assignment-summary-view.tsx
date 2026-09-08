/**
 * **何件が誰にも振られていないかを出す**（#631）。
 *
 * **数えるのは domain（`summarizeAssignments`）が持つ。** **画面は材料を渡すだけ**
 * ——**数を渡させると、材料と食い違ったものを渡せる**（`ReviewBoardProps.changes`
 * と同じ理由）。
 *
 * **bot を除かない。** **除くと「未アサイン 0 件」に見え**、**Dependabot の PR を
 * 誰も見ていない事実が消える**（#625 は人の手が 1 行要った）——**内訳として一緒に出す。**
 *
 * **言うことが無ければ、何も出さない**（#248）。**全部に持ち主が居て、読めなかった
 * ものも無いなら、この行は毎回同じことを言うだけ**である。
 */

import type { Assignment } from "../../domain/triage/assignment";
import { summarizeAssignments } from "../../domain/triage/assignment";

export type AssignmentSummaryViewProps = {
  /** 盤面に出ている PR の番号。**数える母数**である。 */
  readonly pullRequestNumbers: readonly number[];
  /** PR 番号から引ける、誰に振られているか。**読めなかった PR は入らない。** */
  readonly assignments: ReadonlyMap<number, Assignment>;
};

export function AssignmentSummaryView({
  pullRequestNumbers,
  assignments,
}: AssignmentSummaryViewProps) {
  const summary = summarizeAssignments(pullRequestNumbers, assignments);
  // **言うことが無ければ黙る**（#248）——**「未アサイン 0 件」は順番を決めない**
  if (summary.unassigned === 0 && summary.unknown === 0) {
    return undefined;
  }

  return (
    <p className="text-sm opacity-70">
      {summary.unassigned > 0 ? (
        <span>
          誰にも振られていない PR: {summary.unassigned} 件
          {/* **0 件の内訳は足さない**——**読む側に何も足さない**（#248） */}
          {summary.unassignedBots > 0 ? `（うち bot の PR: ${summary.unassignedBots} 件）` : ""}
        </span>
      ) : undefined}
      {/* **「振られていない」に混ぜない**——**混ぜると、読めなかったぶんを
          放置として拾いに行く**（#631。**6 回塞いだ形**） */}
      {summary.unknown > 0 ? (
        <span>　振り先を読めなかった PR: {summary.unknown} 件</span>
      ) : undefined}
    </p>
  );
}
