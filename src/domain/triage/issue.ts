/**
 * issue の盤面（#633）。
 *
 * **PR と同じ型にまとめない**（#633 の本文）。**base / head を持つのは PR だけ**
 * ——**まとめると、issue に「依存」が生えたように見える。**
 *
 * **`Assignment`（#631）とも分けてある。** **issue にレビュー依頼は無い**ので、
 * **同じ型を使うと「レビュー依頼」の欄が常に空になる**——**空の欄は、
 * 読む側に「まだ取れていないのかもしれない」と思わせる。**
 *
 * **数え方は #631 の 2 度目の写しである**（`AGENTS.md` §5「重複は 3 回目に抽象化する」）
 * ——**3 度目が来たら、そこでまとめること。**
 *
 * **純粋関数である**（§3）。
 */

/**
 * 盤面に出す issue 1 件。
 *
 * **番号とタイトルだけ**である。**重複の検知（#630）は、この 2 つから出せる**
 * （`titleOverlapsFor`）ので、**先回りして項目を足さない**（YAGNI）。
 */
export type IssueRef = {
  readonly number: number;
  readonly title: string;
};

/** その issue に振られている人。**レビュー依頼は無い**（PR だけのもの）。 */
export type IssueAssignment = {
  /** assignee の login。**空なら「誰も持っていない」**（**読めなかった、ではない**）。 */
  readonly assignees: readonly string[];
  /**
   * 立てたのが bot か。
   *
   * **未アサインの内訳を出すために運ぶ**（#631 と同じ判断）——**「未アサインが 5 件」の
   * 5 件が全部 bot なら、その数字は何も言っていない。**
   */
  readonly authoredByBot: boolean;
};

/**
 * その issue の状態。
 *
 * **`unknown` を持つ**——**読めなかったものを `unassigned` へ倒すと、
 * 「誰も見ていない」が「取れなかった」を飲み込む**（`AGENTS.md` §5）。
 */
export type IssueAssignmentState = "assigned" | "unassigned" | "unknown";

export function issueAssignmentStateOf(
  assignment: IssueAssignment | undefined,
): IssueAssignmentState {
  if (assignment === undefined) {
    return "unknown";
  }
  return assignment.assignees.length > 0 ? "assigned" : "unassigned";
}

/** 盤面ぶんの数。**「読めなかった」を別に数える。** */
export type IssueAssignmentSummary = {
  readonly total: number;
  /** **誰にも振られていない件数。** */
  readonly unassigned: number;
  /** **そのうち、立てたのが bot のもの。** **除かずに内訳として出す。** */
  readonly unassignedBots: number;
  /** **状態を読めなかった件数。** **未アサインには数えない。** */
  readonly unknown: number;
};

export function summarizeIssueAssignments(
  issues: readonly IssueRef[],
  assignments: ReadonlyMap<number, IssueAssignment>,
): IssueAssignmentSummary {
  let unassigned = 0;
  let unassignedBots = 0;
  let unknown = 0;

  for (const issue of issues) {
    const assignment = assignments.get(issue.number);
    switch (issueAssignmentStateOf(assignment)) {
      case "unknown":
        unknown += 1;
        break;
      case "unassigned":
        unassigned += 1;
        if (assignment?.authoredByBot === true) {
          unassignedBots += 1;
        }
        break;
      default:
        break;
    }
  }
  return { total: issues.length, unassigned, unassignedBots, unknown };
}
