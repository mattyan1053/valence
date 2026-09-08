import { describe, expect, it } from "vitest";
import type { IssueAssignment, IssueRef } from "./issue";
import { issueAssignmentStateOf, summarizeIssueAssignments } from "./issue";

const ISSUES: readonly IssueRef[] = [
  { number: 1, title: "落ちる" },
  { number: 2, title: "遅い" },
  { number: 3, title: "読めない" },
];

function assignment(overrides: Partial<IssueAssignment> = {}): IssueAssignment {
  return { assignees: [], authoredByBot: false, ...overrides };
}

describe("issueAssignmentStateOf", () => {
  it("assignee が居れば、振られている", () => {
    expect(issueAssignmentStateOf(assignment({ assignees: ["someone"] }))).toBe("assigned");
  });

  it("誰も居なければ、誰も持っていない", () => {
    expect(issueAssignmentStateOf(assignment())).toBe("unassigned");
  });

  it("読めなかったものを、誰も持っていない側へ倒さない", () => {
    // **「アサインが無い」と「取れなかった」を分ける**（`AGENTS.md` §5）
    // ——**倒すと、読めなかった issue が「誰も見ていない」を水増しする**
    expect(issueAssignmentStateOf(undefined)).toBe("unknown");
  });
});

describe("summarizeIssueAssignments", () => {
  it("誰も持っていない件数を数える", () => {
    const summary = summarizeIssueAssignments(
      ISSUES,
      new Map([
        [1, assignment({ assignees: ["someone"] })],
        [2, assignment()],
        [3, assignment()],
      ]),
    );

    expect(summary).toEqual({ total: 3, unassigned: 2, unassignedBots: 0, unknown: 0 });
  });

  it("読めなかったものは、未アサインに数えない", () => {
    const summary = summarizeIssueAssignments(ISSUES, new Map([[1, assignment()]]));

    expect(summary.unassigned, "読めなかったぶんまで数えている").toBe(1);
    expect(summary.unknown).toBe(2);
  });

  it("bot が立てたものを除かず、内訳として出す", () => {
    // **除くと「未アサイン 0 件」に見え、bot の issue を誰も見ていない事実が消える**
    // （#631 と同じ判断）——**数えて内訳を出せば、読む側が判断できる**
    const summary = summarizeIssueAssignments(
      ISSUES.slice(0, 2),
      new Map([
        [1, assignment({ authoredByBot: true })],
        [2, assignment()],
      ]),
    );

    expect(summary.unassigned).toBe(2);
    expect(summary.unassignedBots).toBe(1);
  });
});
