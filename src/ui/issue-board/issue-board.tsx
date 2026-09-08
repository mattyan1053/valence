/**
 * issue の盤面（#633）。
 *
 * **PR の盤面の形をそのまま持ち込まない。** **あちらは「押せるか → 順序の目安 →
 * 役割 → 人」**で並んでいるが、**issue に「押せるか」は無い**——**同じ形にすると、
 * 中身の無い行が並ぶ。**
 *
 * **重複の検知はまだ載せない**（#630 が `main` に入ってから）。**`IssueRef` が
 * 番号とタイトルを持っているので、そこから足せる。**
 *
 * **判定はしない**（`RiskTierView` と同じ）——**数えるのは domain
 * （`summarizeIssueAssignments`）が持ち、ここは材料を渡すだけ**である。
 *
 * **`application` を import しない**（`AGENTS.md` §3 の表）——**受けるのは
 * ドメインの型と、数えられなかった件数だけ**である。
 */

import type { IssueAssignment, IssueRef } from "../../domain/triage/issue";
import { issueAssignmentStateOf, summarizeIssueAssignments } from "../../domain/triage/issue";

export type IssueBoardProps = {
  /**
   * open な issue。
   *
   * **`undefined` は「一覧を取れなかった」**である——**空の配列と混ぜない。**
   * **混ぜると、取れなかった日に「issue はありません」と出る**（`AGENTS.md` §5）。
   */
  readonly issues: readonly IssueRef[] | undefined;
  /** issue 番号から引ける、誰に振られているか。**読めなかったものは入らない。** */
  readonly assignments: ReadonlyMap<number, IssueAssignment>;
  /**
   * 応答は返ったが、読めなかった件数。
   *
   * **黙って落とさない**——**落とすと「取得できたが読めなかった」と
   * 「そもそも無かった」が区別できない。**
   */
  readonly unreadable: number;
  /** **人が開く GitHub の場所**（#621）。**組み立ては合成ルートが持つ。** */
  readonly urlOf: (issueNumber: number) => string;
};

/**
 * **その行が言うこと。** **言うことが無ければ `undefined`**（#248）
 * ——**毎行に同じ札が出ると読まれなくなる。**
 */
const ASSIGNMENT_TEXT: Record<ReturnType<typeof issueAssignmentStateOf>, string | undefined> = {
  assigned: undefined,
  unassigned: "誰も持っていません",
  // **「持っていない」と別の文にする**——**同じ顔にすると、読めなかったぶんを
  // 拾いに行くことになる**（#631。**このリポジトリが 6 回塞いだ形**）
  unknown: "振り先を読めていません",
};

export function IssueBoard({ issues, assignments, unreadable, urlOf }: IssueBoardProps) {
  if (issues === undefined) {
    return <p className="text-sm opacity-70">issue の一覧を読めませんでした</p>;
  }
  if (issues.length === 0) {
    return <p className="text-sm opacity-70">open な issue はありません</p>;
  }
  const summary = summarizeIssueAssignments(issues, assignments);

  return (
    <div className="flex flex-col gap-2">
      {/* **数えたことを先に出す**（#597）——**一覧を開かずに「次にどれを見るか」が決まる** */}
      {(summary.unassigned > 0 || summary.unknown > 0 || unreadable > 0) && (
        <p className="text-sm opacity-70">
          {summary.unassigned > 0 && (
            <span>
              誰にも振られていない issue: {summary.unassigned} 件
              {summary.unassignedBots > 0
                ? `（うち bot の issue: ${summary.unassignedBots} 件）`
                : ""}
            </span>
          )}
          {summary.unknown > 0 && <span>　振り先を読めなかった issue: {summary.unknown} 件</span>}
          {unreadable > 0 && <span>　読めなかった issue: {unreadable} 件</span>}
        </p>
      )}
      <ul className="flex list-none flex-col gap-1">
        {issues.map((issue) => {
          const note = ASSIGNMENT_TEXT[issueAssignmentStateOf(assignments.get(issue.number))];
          return (
            <li className="text-sm" key={issue.number}>
              <a className="underline" href={urlOf(issue.number)}>
                #{issue.number}
              </a>
              {/* **区切りは文字で置く**（#605 のレビュー）——**class に頼ると、
                  出ていなくても markup は同じ**なので、**試験では気づけない。** */}
              <span> {issue.title}</span>
              {note !== undefined && (
                <>
                  <span aria-hidden="true">／</span>
                  <span className="text-[var(--muted)]">{note}</span>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
