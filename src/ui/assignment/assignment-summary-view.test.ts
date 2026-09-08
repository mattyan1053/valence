import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Assignment } from "../../domain/triage/assignment";
import type { AssignmentSummaryViewProps } from "./assignment-summary-view";
import { AssignmentSummaryView } from "./assignment-summary-view";

function assignment(overrides: Partial<Assignment> = {}): Assignment {
  return { assignees: [], reviewers: [], authoredByBot: false, ...overrides };
}

function render(props: AssignmentSummaryViewProps): string {
  return renderToStaticMarkup(createElement(AssignmentSummaryView, props));
}

describe("誰にも振られていない件数を出す", () => {
  it("件数が出る", () => {
    const html = render({
      pullRequestNumbers: [1, 2, 3],
      assignments: new Map([
        [1, assignment()],
        [2, assignment({ assignees: ["a"] })],
        [3, assignment()],
      ]),
    });

    expect(html).toContain("2 件");
  });

  it("bot の内訳を一緒に出す", () => {
    // **除かずに内訳を出す**（#631 の判断どころ）——**「5 件が全部 Dependabot」なら、
    // 内訳がそう言う**
    const html = render({
      pullRequestNumbers: [1, 2],
      assignments: new Map([
        [1, assignment({ authoredByBot: true })],
        [2, assignment()],
      ]),
    });

    expect(html).toContain("bot");
  });

  it("bot が 1 件も無ければ、内訳は出さない", () => {
    // **0 件の内訳は、読む側に何も足さない**（#248）
    const html = render({
      pullRequestNumbers: [1],
      assignments: new Map([[1, assignment()]]),
    });

    expect(html).not.toContain("bot");
  });

  it("読めなかった件数は、別に出す", () => {
    // **「振られていない」に混ぜない**（#631。**6 回塞いだ形**）
    const html = render({ pullRequestNumbers: [1, 2], assignments: new Map() });

    expect(html).toContain("読め");
  });

  it("言うことが無ければ、何も出さない", () => {
    // **平常時に鳴るものは読まれなくなる**（#248）
    const html = render({
      pullRequestNumbers: [1],
      assignments: new Map([[1, assignment({ assignees: ["a"] })]]),
    });

    expect(html).toBe("");
  });

  it("PR が 1 件も無ければ、何も出さない", () => {
    expect(render({ pullRequestNumbers: [], assignments: new Map() })).toBe("");
  });
});
