import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PullRequestRef } from "../../domain/graph/dependency-graph";
import type { ChangeSummary } from "../../domain/triage/risk-tier";
import type { SuggestedReviewOrderProps } from "./suggested-review-order";
import { reviewReasonNote, SuggestedReviewOrder } from "./suggested-review-order";

function pullRequest(number: number, head: string): PullRequestRef {
  return {
    number,
    base: { repository: "r", branch: "main" },
    head: { repository: "r", branch: head },
  };
}

function change(overrides: Partial<ChangeSummary> = {}): ChangeSummary {
  const ciStatus = overrides.ciStatus ?? "passing";
  return {
    changedFileCount: 1,
    changedLineCount: 5,
    changedPaths: { paths: ["src/ui/button.tsx"], truncated: false },
    ciStatus,
    // **`ciStatus` と食い違わせない**（#638）——**材料を作る側は同じ判定から
    // 両方を出す**ので、**「落ちているのに 1 件も挙がらない」入力は起こりえない**
    failingChecks:
      ciStatus === "failing" ? [{ kind: "check-run", name: "test", outcome: "failure" }] : [],
    baseCi: undefined,
    ...overrides,
  };
}

/** **影響の大きいパス**——`classifyRiskTier` が `high-risk` を返す形。 */
const RISKY: ChangeSummary = change({
  changedPaths: { paths: ["src/infrastructure/github/app-jwt.ts"], truncated: false },
});

function props(overrides: Partial<SuggestedReviewOrderProps> = {}): SuggestedReviewOrderProps {
  return {
    pullRequests: [pullRequest(1, "feat/a"), pullRequest(2, "feat/b")],
    order: { ordered: [1, 2], cyclic: [] },
    changes: new Map([
      [1, change()],
      [2, RISKY],
    ]),
    mergeStatusOf: () => ({ mergeable: "mergeable", state: "clean" }),
    titleOf: (number: number) => `#${number} のタイトル`,
    urlOf: (number: number) => `https://github.com/o/n/pull/${number}`,
    ...overrides,
  };
}

function render(overrides: Partial<SuggestedReviewOrderProps> = {}): string {
  return renderToStaticMarkup(createElement(SuggestedReviewOrder, props(overrides)));
}

/** 一覧の中だけを見る。**見出しや注記に当てない。** */
function list(markup: string): string {
  const from = markup.indexOf("<ol");
  expect(from, "一覧が出ていない").toBeGreaterThanOrEqual(0);
  const to = markup.indexOf("</ol>", from);
  expect(to, "一覧が閉じていない").toBeGreaterThan(from);
  return markup.slice(from, to);
}

describe("推奨レビュー順", () => {
  it("時間が要るものが先に出る", () => {
    const rows = list(render());

    expect(rows.indexOf("#2")).toBeLessThan(rows.indexOf("#1"));
  });

  it("なぜその順なのかが、行に出る", () => {
    // **順番だけ出しても、判定を検算できない**（#632 の完了条件）
    const rows = list(render());

    expect(rows).toContain(reviewReasonNote("high-risk"));
    expect(rows).toContain(reviewReasonNote("fast-track"));
  });

  it("マージの順序ではないことを、その場で言う", () => {
    // **混ぜて読まれると、土台より先に積み荷をマージしようとする**
    expect(render()).toMatch(/マージ/);
  });

  it("1 件も落とさない", () => {
    // **並べ替えであって、絞り込みではない**——**材料が 1 件も無くても、行は残る**
    //
    // **`#1` を数えない**（`AGENTS.md` §4）——**タイトル（`#1 のタイトル`）にも
    // 出るので、1 件あたり 2 回当たる。** **数えるのは行そのもの。**
    const rows = list(render({ changes: new Map() }));

    expect(rows.match(/<li/g), "行が 2 件ではない").toHaveLength(2);
  });

  it("PR が 1 件も無ければ、何も出さない", () => {
    // **見出しだけが残ると、壊れているのか空なのか分からない**
    expect(render({ pullRequests: [], order: { ordered: [], cyclic: [] } })).toBe("");
  });

  it("理由は、それぞれ違う文で出る", () => {
    // **同じ文なら、言い分けた意味が無い**（`changeUnavailableNote` と同じ判断）
    const notes = (
      ["high-risk", "needs-review", "fast-track", "unknown", "needs-author"] as const
    ).map(reviewReasonNote);

    expect(new Set(notes).size, "言い分けられていない").toBe(5);
  });
});
