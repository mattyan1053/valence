import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PullRequestRef } from "../../domain/graph/dependency-graph";
import type { ChangeSummary } from "../../domain/triage/risk-tier";
import type { SuggestedReviewOrderProps } from "./suggested-review-order";
import { groupByReason, reviewReasonNote, SuggestedReviewOrder } from "./suggested-review-order";

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
    // 出るので、1 件あたり 2 回当たる。**
    //
    // **`<li>` も数えない** (#704)。**理由で束ねたので、`<li>` は束のぶんも増える**
    // ——**2 件が 1 つの束に入ると 3 つ**になる（**材料が無ければ理由は同じ**）。
    // **数えるのは PR の行き先**——**1 件につき 1 回で、他には出ない。**
    const rows = list(render({ changes: new Map() }));

    expect(
      rows.match(/href="https:\/\/github\.com\/o\/n\/pull\//g),
      "行が 2 件ではない",
    ).toHaveLength(2);
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

/**
 * **同じ理由を、行ごとに繰り返さない**（#704）。
 *
 * **数えた**（`./task board:sample` の 12 行）——**5 行が「いつもどおり読むものです」**、
 * **4 行が「著者の手が要ります（…）」**。**12 行のうち 9 行が、2 つの文のどちらか**だった。
 *
 * **理由は消さない**（#632 の完了条件）——**束ねる。**
 */
describe("同じ理由を束ねる", () => {
  /**
   * **ふつうに読むもの**（`classifyRiskTier` の `normal`）。
   *
   * **既定の `change()` は `fast-track` になる**（**3 ファイル・50 行まで**）
   * ——**理由を名指しする試験では、その理由になる材料を置く。**
   */
  const NORMAL: ChangeSummary = change({ changedFileCount: 5, changedLineCount: 200 });

  /** **同じ理由になる PR を 3 本**（**材料が同じなら理由も同じ**）。 */
  const THREE_SAME = {
    pullRequests: [pullRequest(1, "a"), pullRequest(2, "b"), pullRequest(3, "c")],
    order: { ordered: [1, 2, 3], cyclic: [] },
    changes: new Map([
      [1, NORMAL],
      [2, NORMAL],
      [3, NORMAL],
    ]),
  };

  it("理由は 1 回だけ出る", () => {
    // **「行の属性ではないもの」を行ごとに言わない**——**3 本で 3 回出ていた**
    const html = render(THREE_SAME);
    const note = reviewReasonNote("needs-review");

    expect(html.split(note).length - 1, `理由が繰り返されている: ${note}`).toBe(1);
  });

  it("束ねても、PR は全部出る", () => {
    const rows = list(render(THREE_SAME));

    for (const number of ["#1", "#2", "#3"]) {
      expect(rows, `${number} が消えている`).toContain(number);
    }
  });

  it("理由が違えば、別々に出る", () => {
    // **#632 の完了条件**——**なぜその順かが読めること**
    const html = render({
      changes: new Map([
        [1, NORMAL],
        [2, RISKY],
      ]),
    });

    expect(html).toContain(reviewReasonNote("needs-review"));
    expect(html).toContain(reviewReasonNote("high-risk"));
  });

  it("1 本だけでも破綻しない", () => {
    const html = render({
      pullRequests: [pullRequest(1, "a")],
      order: { ordered: [1], cyclic: [] },
      changes: new Map([[1, NORMAL]]),
    });

    expect(list(html), "行が出ていない").toContain("#1");
    expect(html.split(reviewReasonNote("needs-review")).length - 1).toBe(1);
  });

  it("束ねても、順は保たれる", () => {
    // **推奨レビュー順は「順」が中身である**——**束ねて順が消えたら意味が無い**
    const rows = list(
      render({
        pullRequests: [pullRequest(1, "a"), pullRequest(2, "b"), pullRequest(3, "c")],
        order: { ordered: [1, 2, 3], cyclic: [] },
        changes: new Map([
          [1, NORMAL],
          [2, RISKY],
          [3, NORMAL],
        ]),
      }),
    );

    // **時間が要るもの（#2）が先**、**そのあと #1 → #3**（依存の順）
    expect(rows.indexOf("#2")).toBeLessThan(rows.indexOf("#1"));
    expect(rows.indexOf("#1")).toBeLessThan(rows.indexOf("#3"));
  });
});

/**
 * **束ね方そのものを見る**（#693 の形）。
 *
 * **画面越しには測れない**——**`suggestReviewOrder` が理由で並べ替えたあと**なので、
 * **同じ理由が離れて出る入力は、この画面には来ない。** **「連なりだけを束ねる」と
 * 「全部を集める」の差が、本物の材料からは出ない**ので、**束ね方を単体で見る。**
 */
describe("連なりを束ねる", () => {
  it("続いているものだけを 1 つにする", () => {
    const groups = groupByReason([
      { number: 1, reason: "needs-review" },
      { number: 2, reason: "needs-review" },
      { number: 3, reason: "high-risk" },
      { number: 4, reason: "needs-review" },
    ]);

    expect(groups.map((group) => group.reason)).toEqual([
      "needs-review",
      "high-risk",
      "needs-review",
    ]);
    expect(groups.map((group) => group.numbers)).toEqual([[1, 2], [3], [4]]);
  });

  it("1 件も無ければ、束も無い", () => {
    expect(groupByReason([])).toEqual([]);
  });
});
