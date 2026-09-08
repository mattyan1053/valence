import { describe, expect, it } from "vitest";
import type { Assignment } from "../../domain/triage/assignment";
import { assignmentNote } from "./assignment-note";

function assignment(overrides: Partial<Assignment> = {}): Assignment {
  return { assignees: [], reviewers: [], authoredByBot: false, ...overrides };
}

describe("誰に振られているかを、行の言葉にする", () => {
  it("アサインされている人を出す", () => {
    expect(assignmentNote(assignment({ assignees: ["someone"] }))).toContain("someone");
  });

  it("レビュー依頼の宛先を出す", () => {
    expect(assignmentNote(assignment({ reviewers: ["a", "b"] }))).toContain("b");
  });

  it("誰にも振られていないことが分かる", () => {
    // **この Issue が消しに来た状態**——**誰も見ていない PR が、他と同じ顔で並ぶ**
    expect(assignmentNote(assignment())).toContain("誰にも");
  });

  it("読めなかったことが分かる", () => {
    // **「アサインが無い」と混ぜない**（#631。**6 回塞いだ形**）
    expect(assignmentNote(undefined)).toContain("読め");
  });

  it("振られていないのと、読めなかったのを、同じ文にしない", () => {
    expect(assignmentNote(assignment())).not.toBe(assignmentNote(undefined));
  });

  it("アサインとレビュー依頼が両方あれば、両方出す", () => {
    // **持ち主と、見てほしい相手は別**である
    const note = assignmentNote(assignment({ assignees: ["owner"], reviewers: ["reviewer"] }));

    expect(note).toContain("owner");
    expect(note).toContain("reviewer");
  });
});
