import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { IssueAssignment, IssueRef } from "../../domain/triage/issue";
import type { IssueBoardProps } from "./issue-board";
import { IssueBoard } from "./issue-board";

function assignment(overrides: Partial<IssueAssignment> = {}): IssueAssignment {
  return { assignees: [], authoredByBot: false, ...overrides };
}

const ISSUES: readonly IssueRef[] = [
  { number: 1, title: "落ちる" },
  { number: 2, title: "遅い" },
];

function view(overrides: Partial<IssueBoardProps> = {}): string {
  return renderToStaticMarkup(
    createElement(IssueBoard, {
      issues: ISSUES,
      assignments: new Map([
        [1, assignment({ assignees: ["someone"] })],
        [2, assignment()],
      ]),
      unreadable: 0,
      urlOf: (number: number) => `https://github.com/o/r/issues/${number}`,
      ...overrides,
    }),
  );
}

describe("IssueBoard", () => {
  it("番号とタイトルを出す", () => {
    const markup = view();

    expect(markup).toContain("落ちる");
    expect(markup).toContain("#2");
  });

  it("GitHub の issue へ行ける", () => {
    // **置き換えず拡張する**（`AGENTS.md` §1）——**本文を読むのは GitHub 側**である
    expect(view()).toContain('href="https://github.com/o/r/issues/1"');
  });

  it("誰にも振られていない issue が分かる", () => {
    expect(view()).toContain("誰にも振られていない issue: 1 件");
  });

  it("振り先を読めなかった issue を、振られていない側へ倒さない", () => {
    // **「アサインが無い」と「取れなかった」を分ける**（`AGENTS.md` §5）
    const markup = view({ assignments: new Map() });

    expect(markup).toContain("振り先を読めなかった issue: 2 件");
    expect(markup, "読めなかったぶんを未アサインに数えている").not.toContain(
      "誰にも振られていない issue: 2 件",
    );
  });

  it("issue が 1 件も無いときは、そう言う", () => {
    // **「0 件」と「取れなかった」を、同じ顔にしない**
    const markup = view({ issues: [], assignments: new Map() });

    expect(markup).toContain("open な issue はありません");
    expect(markup, "読めなかったことにしている").not.toContain("一覧を読めませんでした");
  });

  it("一覧そのものを取れなかったときは、そう言う", () => {
    const markup = view({ issues: undefined });

    expect(markup).toContain("一覧を読めませんでした");
    expect(markup, "0 件と同じ顔になっている").not.toContain("open な issue はありません");
  });

  it("読めなかった件数を、黙って落とさない", () => {
    // **捨てると「取得できたが読めなかった」と「そもそも無かった」が区別できない**
    expect(view({ unreadable: 3 })).toContain("読めなかった issue: 3 件");
  });

  it("bot が立てたぶんを、内訳として出す", () => {
    // **除くと「未アサイン 0 件」に見え、bot の issue を誰も見ていない事実が消える**
    const markup = view({
      assignments: new Map([
        [1, assignment({ authoredByBot: true })],
        [2, assignment()],
      ]),
    });

    expect(markup).toContain("うち bot の issue: 1 件");
  });

  it("言うことが無ければ、余計な行を出さない", () => {
    // **全部に持ち主が居て、読めなかったものも無いなら、その行は毎回同じことを言う**（#248）
    const markup = view({
      assignments: new Map([
        [1, assignment({ assignees: ["a"] })],
        [2, assignment({ assignees: ["b"] })],
      ]),
    });

    expect(markup).not.toContain("誰にも振られていない");
    expect(markup).not.toContain("読めなかった");
  });
});
