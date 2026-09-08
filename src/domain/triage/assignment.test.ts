import { describe, expect, it } from "vitest";
import type { Assignment } from "./assignment";
import { assignmentStateOf, summarizeAssignments } from "./assignment";

function assignment(overrides: Partial<Assignment> = {}): Assignment {
  return { assignees: [], reviewers: [], authoredByBot: false, ...overrides };
}

describe("誰に振られているかを読む", () => {
  it("アサインされていれば、そう言う", () => {
    expect(assignmentStateOf(assignment({ assignees: ["someone"] }))).toBe("assigned");
  });

  it("レビュー依頼だけ出ていれば、そう言う", () => {
    // **アサインとレビュー依頼は別**である——**依頼だけでも、見る人は決まっている**
    expect(assignmentStateOf(assignment({ reviewers: ["someone"] }))).toBe("review-requested");
  });

  it("どちらも無ければ、誰にも振られていない", () => {
    expect(assignmentStateOf(assignment())).toBe("unassigned");
  });

  it("読めなかったものを、振られていない側へ倒さない", () => {
    // **「アサインが無い」と「取れなかった」を分ける**（#631。**6 回塞いだ形**）
    expect(assignmentStateOf(undefined)).toBe("unknown");
  });

  it("アサインとレビュー依頼が両方あれば、アサインを先に言う", () => {
    // **持ち主が決まっている**ほうが強い
    expect(assignmentStateOf(assignment({ assignees: ["a"], reviewers: ["b"] }))).toBe("assigned");
  });
});

describe("盤面ぶんを数える", () => {
  it("誰にも振られていない件数を数える", () => {
    const summary = summarizeAssignments(
      [1, 2, 3],
      new Map([
        [1, assignment()],
        [2, assignment({ assignees: ["a"] })],
        [3, assignment()],
      ]),
    );

    expect(summary).toEqual({ total: 3, unassigned: 2, unassignedBots: 0, unknown: 0 });
  });

  it("bot の PR を、内訳として一緒に出す", () => {
    // **除かない**（#631 の判断どころ）——**除くと「未アサイン 0 件」に見え**、
    // **Dependabot の PR を誰も見ていない事実が消える**（#625 は人の手が 1 行要った）。
    // **数えて内訳を出せば、読む側が判断できる**
    const summary = summarizeAssignments(
      [1, 2],
      new Map([
        [1, assignment({ authoredByBot: true })],
        [2, assignment()],
      ]),
    );

    expect(summary.unassigned).toBe(2);
    expect(summary.unassignedBots).toBe(1);
  });

  it("アサインされている bot の PR は、内訳に入らない", () => {
    const summary = summarizeAssignments(
      [1],
      new Map([[1, assignment({ authoredByBot: true, assignees: ["a"] })]]),
    );

    expect(summary).toEqual({ total: 1, unassigned: 0, unassignedBots: 0, unknown: 0 });
  });

  it("読めなかったものは、未アサインに数えない", () => {
    // **「取れなかった」を「誰も見ていない」に化けさせない**——**別に数える**
    const summary = summarizeAssignments([1, 2], new Map([[2, assignment()]]));

    expect(summary).toEqual({ total: 2, unassigned: 1, unassignedBots: 0, unknown: 1 });
  });

  it("PR が 1 件も無ければ、全部 0 になる", () => {
    expect(summarizeAssignments([], new Map())).toEqual({
      total: 0,
      unassigned: 0,
      unassignedBots: 0,
      unknown: 0,
    });
  });
});
