import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PullRequestRef } from "../../domain/graph/dependency-graph";
import type { ChangeSummary } from "../../domain/triage/risk-tier";
import { boardCellClass } from "../board/board-table";
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
    // **既定は「今日動いた」**（#717）——**この試験群が見ているのは、そこではない**
    activeDaysOf: () => 0,
    ...overrides,
  };
}

function render(overrides: Partial<SuggestedReviewOrderProps> = {}): string {
  return renderToStaticMarkup(createElement(SuggestedReviewOrder, props(overrides)));
}

/**
 * 一覧の中だけを見る。**見出しや注記に当てない。**
 *
 * **一覧は表である**（#717。**`<ol>` の入れ子だった**）——**束は `<tbody>` 1 つ**で、
 * **束の中の行はその中の `<tr>`** である。
 */
function list(markup: string): string {
  const from = markup.indexOf("<table");
  expect(from, "一覧が出ていない").toBeGreaterThanOrEqual(0);
  const to = markup.lastIndexOf("</table>");
  expect(to, "一覧が閉じていない").toBeGreaterThan(from);
  return markup.slice(from, to);
}

/** 束（`<tbody>` 1 つ）に割る。**理由が 1 回だけ出る単位**である（#704）。 */
function groups(markup: string): readonly string[] {
  return list(markup)
    .split("<tbody")
    .slice(1)
    .map((one) => `<tbody${one}`);
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

  it("束は、表の中でも 1 つのまとまりである", () => {
    // **束ねを捨てると #704 が戻る**（**全行に同じ理由が出る**）——**表にしても、
    // 束は `<tbody>` 1 つ**である。**3 件が同じ理由なら、束は 1 つ。**
    const found = groups(render(THREE_SAME));

    expect(found, "束が 1 つになっていない").toHaveLength(1);
    expect(
      [...(found[0] ?? "").matchAll(/<tr[\s>]/g)],
      "理由の段と 3 行で 4 段にならない",
    ).toHaveLength(4);
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

/**
 * **推奨レビュー順も表にする**（#717 / #714）。
 *
 * **利用者が最初に名指しした節**である（#713 の引用）——**束ねたぶん短くはなったが、
 * 列が無い**ので、**どれが大きい PR か、どれが古いかが並べて見えなかった。**
 */
describe("推奨レビュー順が表になっている（#717）", () => {
  function header(markup: string): string {
    const from = markup.indexOf("<thead");
    expect(from, "見出しの段が無い").toBeGreaterThanOrEqual(0);
    return markup.slice(from, markup.indexOf("</thead>", from));
  }

  it("読む時間を決める列が並んでいる", () => {
    const head = header(render());

    expect(head, "CI の列が無い").toContain("CI");
    expect(head, "サイズの列が無い").toContain("サイズ");
    expect(head, "active 日数の列が無い").toContain("最後に動いた");
  });

  it("依存 PR 数の列は出さない", () => {
    // **マージ順と混ぜない**（#717 の注意。`review-board.tsx` の元からの判断）
    // ——**依存の本数は「守らないと壊れる制約」の側**で、**この節は目安**である。
    // **同じ列を使えるはず、を確かめた結果、ここだけは使えない。**
    expect(header(render()), "マージ順の列が混ざっている").not.toContain("依存 PR 数");
  });

  it("列に、その PR の材料が入る", () => {
    const html = render({
      changes: new Map([
        [1, change({ changedFileCount: 3, changedLineCount: 42, ciStatus: "failing" })],
        [2, RISKY],
      ]),
      activeDaysOf: (number: number) => (number === 1 ? 5 : 0),
    });
    const row = list(html).slice(list(html).indexOf("#1 のタイトル"));

    expect(row, "CI の状況が出ていない").toContain("落ちた");
    expect(row, "サイズが出ていない").toContain("3 ファイル / 42 行");
    expect(row, "active 日数が出ていない").toContain("5 日前");
  });

  it("読めなかった材料を、空欄にしない", () => {
    // **空欄は「無い」と見分けが付かない**（`AGENTS.md` §5）。
    // **材料が 1 件も無い盤面**——**2 件 × 3 列で 6 マス。**
    const html = render({ changes: new Map(), activeDaysOf: () => undefined });

    expect([...list(html).matchAll(/読めません/g)], "読めなかった列が黙っている").toHaveLength(6);
  });

  it("数字の列は、桁が揃う", () => {
    // **揃わないと、比べるために読むことになる**（#714 の注意）。
    // **器が決めている**（`boardCellClass`）——**こちらの表でも効いていること**を見る
    // （**盤面の表だけで測ると、この節が器を通っていなくても緑**になる）。
    const row = list(render()).slice(list(render()).indexOf("#1 のタイトル"));
    const classes = [...row.matchAll(/<td class="([^"]*)"/g)].map(([, one]) => one ?? "");

    expect(classes.length, "列が出ていない").toBeGreaterThan(0);
    expect(
      classes.filter((one) => /\btabular-nums\b/.test(one)).length,
      "桁を揃えた列が 2 つ無い（サイズ・active）",
    ).toBeGreaterThanOrEqual(2);
  });

  it("理由は、その束の行の見出しとして読まれる", () => {
    // **`colgroup` は列の束**（#724 のレビュー）——**後ろに続く行に結び付かない。**
    // **束は `<tbody>`（行の束）**なので、**`rowgroup` である。**
    // **#632 の「理由を消さない」は、読み上げでも成立していないと満たせない。**
    const group = groups(render())[0] ?? "";
    const heading = /<th[^>]*colSpan|<th[^>]*colspan/i.exec(group);

    expect(heading, "理由の段が出ていない").not.toBeNull();
    expect(group, "理由が列の束に結び付いている").not.toContain('scope="colgroup"');
    expect(group, "理由が行の束に結び付いていない").toContain('scope="rowgroup"');
  });

  it("行の見出しも、器の規則を通っている", () => {
    // **#724 のレビュー 2 周目**——**`COLUMNS` に規則があるのに、行の見出しだけ
    // 器を通っていなかった。** **2 つの表の両方で結線を見る**
    // （**片方だけ直しても、もう片方は同じ穴のまま**）。
    const group = groups(render())[0] ?? "";
    // **1 つ目の `<th>` は理由の段**（束の見出し）——**行の見出しはその次**である
    const headings = [...group.matchAll(/<th[^>]*class="([^"]*)"/g)].map(([, one]) => one ?? "");

    expect(headings[1], "行の見出しが出ていない").toBeDefined();
    for (const rule of boardCellClass("pull-request").split(" ")) {
      expect(headings[1], `器の規則が行の見出しに届いていない: ${rule}`).toContain(rule);
    }
  });

  it("行を開かせない", () => {
    // **#716 と同じ判断**（**畳みが二重になると開くのに 2 回押す**）——**こちらは
    // そもそも畳む中身が無い**（**理由は束の段に出ている**）。
    expect(render(), "畳みが増えている").not.toContain("<details");
  });

  it("狭い画面で、列が潰れずに横へ流れる", () => {
    const markup = render();
    const before = markup.slice(0, markup.indexOf("<table"));

    expect(before, "表を包む器が無い").toMatch(/<div class="[^"]*\boverflow-x-auto\b[^"]*">\s*$/);
  });
});
