import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DependencyEdge, PullRequestRef } from "../../domain/graph/dependency-graph";
import { buildDependencyEdges } from "../../domain/graph/dependency-graph";
import type { DependencyOrder } from "../../domain/graph/dependency-order";
import { orderByDependency } from "../../domain/graph/dependency-order";
import type { ChangeSummary } from "../../domain/triage/risk-tier";
import type { ReviewBoardProps } from "./review-board";
import { ReviewBoard } from "./review-board";

function render(props: ReviewBoardProps): string {
  return renderToStaticMarkup(createElement(ReviewBoard, props));
}

function pullRequest(number: number, base: string, head: string): PullRequestRef {
  return {
    number,
    base: { repository: "r", branch: base },
    head: { repository: "r", branch: head },
  };
}

function change(overrides: Partial<ChangeSummary> = {}): ChangeSummary {
  return {
    changedFileCount: 1,
    changedLineCount: 5,
    touchesSensitivePath: false,
    ciStatus: "passing",
    ...overrides,
  };
}

/** #2 が #1 の上に積まれている、いちばん小さなスタック。 */
const STACK: readonly PullRequestRef[] = [
  pullRequest(1, "main", "feat/a"),
  pullRequest(2, "feat/a", "feat/b"),
];
const EDGES: readonly DependencyEdge[] = [{ dependent: 2, dependsOn: 1 }];
const ORDER: DependencyOrder = { ordered: [1, 2], cyclic: [] };

function props(overrides: Partial<ReviewBoardProps> = {}): ReviewBoardProps {
  return {
    pullRequests: STACK,
    edges: EDGES,
    order: ORDER,
    invalid: [],
    // **既定はタイトルを返す**（#542）——**この試験群が見ているのは、そこではない**
    titleOf: (number: number) => `#${number} のタイトル`,
    changes: new Map([
      [1, change()],
      [2, change()],
    ]),
    // **既定は「分かっている」**——**この試験群が見ているのは、そこではない**
    headKnown: () => true,
    ...overrides,
  };
}

/**
 * **状態の表示は、材料が無い行にも出す**（#343）。
 *
 * **材料（リスク Tier）が揃っていないことと、承認済みかどうかは別**である
 * ——**片方の行にだけ出すと、「押した結果が出ない」行が残る。**
 */
describe("各行へ状態を足す", () => {
  it("材料がある行にも、無い行にも出る", () => {
    const html = render(
      props({
        changes: new Map([[1, change()]]),
        renderStatus: (number) => createElement("i", { key: number }, `状態${number}`),
      }),
    );

    expect(html).toContain("状態1");
    // **材料が無い行**（#2 は `changes` に無い）
    expect(html).toContain("状態2");
  });

  it("渡さなければ、何も出ない", () => {
    // **任意の口である**——**渡さないことは「抜け」ではない**
    expect(render(props())).not.toContain("状態");
  });

  it("操作の口とは別に受ける", () => {
    // **押すものと、押した結果として出るものを混ぜない**
    // ——**混ぜると、状態を足すたびに操作の口を触ることになる**
    const html = render(
      props({
        renderStatus: (number) => createElement("i", { key: number }, "承認済み"),
        renderActions: (number) =>
          createElement("button", { key: number, type: "button" }, "Approve"),
      }),
    );

    expect(html).toContain("承認済み");
    expect(html).toContain("Approve");
  });
});

/**
 * 一覧（`<ol>`）の中だけ。
 *
 * **図にも同じ `#1` / `#2` が出る** (#474 のレビュー 2 周目)——**図は一覧より先に描かれる**
 * ので、**全体を見る判定は図の並びで満たされ**、**一覧の行順が逆転しても緑のまま**になる。
 * **Tier・状態・操作が付くのは一覧の行**なので、**そこの並びを見る側は、ここを通す。**
 *
 * **狭めた先が空でも黙らない**——**一覧そのものが消えたら、ここで落ちる。**
 */
function list(markup: string): string {
  const from = markup.indexOf("<ol");
  expect(from, "一覧が出ていない").toBeGreaterThanOrEqual(0);
  const to = markup.indexOf("</ol>", from);
  expect(to, "一覧が閉じていない").toBeGreaterThan(from);
  return markup.slice(from, to);
}

describe("ReviewBoard", () => {
  it("依存の順に並んだ各行に Tier が出る", () => {
    const rows = list(render(props()));

    expect(rows.indexOf("#1")).toBeLessThan(rows.indexOf("#2"));
    // 2 件とも Tier が出ている（#110 の表示をそのまま使う）
    expect(rows.match(/すぐ通せる/g)).toHaveLength(2);
  });

  it("Tier で並べ替えない", () => {
    // **依存の順は守らないとマージできない制約**で、**Tier は優先度の目安**でしかない。
    // 混ぜると「急ぐべき PR が先に見える」せいで、**土台より先に積み荷をマージしようとする**
    // ——このプロダクトが解こうとしている問題を、画面が作り出すことになる
    const markup = render(
      props({
        changes: new Map([
          [1, change()], // fast-track（土台）
          [2, change({ touchesSensitivePath: true })], // high-risk（その上）
        ]),
      }),
    );

    const rows = list(markup);

    expect(rows.indexOf("#1")).toBeLessThan(rows.indexOf("#2"));
    expect(rows.indexOf("すぐ通せる")).toBeLessThan(rows.indexOf("先に人が見る"));
  });

  describe("判定材料が無い PR", () => {
    it("行として残り、Tier が不明だと分かる", () => {
      // **黙って落とさない。** #107 の `invalid` と同じ形で、
      // 「出せなかった」を「無かった」にしない
      const markup = render(props({ changes: new Map([[1, change()]]) }));

      expect(markup).toContain("#2");
      expect(markup).toMatch(/材料|不明|分かりません/);
    });

    it("材料が揃っていれば、その断りを出さない", () => {
      expect(render(props())).not.toMatch(/材料|不明|分かりません/);
    });
  });

  it("依存グラフ側の注意書きが消えない", () => {
    // **合成しても、#107 が塞いだ穴が開かない**こと
    const markup = render(
      props({
        order: { ordered: [1], cyclic: [2] },
        invalid: [{ index: 4, reason: "番号が数値ではありません" }],
      }),
    );

    expect(markup).toMatch(/抜け/);
    expect(markup).toMatch(/その先に積まれ/);
    expect(markup).toContain("番号が数値ではありません");
  });
});

/**
 * **盤面の側でも、1 件も無いことが読める**（#410）。
 *
 * **人が開くのは盤面**である——**部品が出していても、盤面が別の並べ方をしていれば
 * 届かない**（`AGENTS.md` §5: **入れたが、実行される場所に届いていない**）。
 */
describe("1 件も無いとき", () => {
  it("盤面にも、何が無いのかが出る", () => {
    const markup = render(
      props({
        pullRequests: [],
        edges: [],
        order: { ordered: [], cyclic: [] },
        changes: new Map(),
      }),
    );

    expect(markup, "何も見えない画面になっている").toMatch(/ありません/);
  });
});

/**
 * **10 本並べたとき、図の中だけで「次に見る 1 本」が決まるか**（#540）。
 *
 * **「読める」と「決められる」は別**である（#505 の次の段）。**箱に番号しか
 * 入っていないと、危なさも何待ちかも脇の文章にしか無い**——**溺れている人は、
 * 文章を読む前に「どれから見るか」を決めたい**（README）。
 *
 * **測るのは `<svg>` の中だけ**である。**外（一覧の文章）を混ぜると、
 * 「文章を読まずに選べる」を測ったことにならない**——**実データは要らない**ので、
 * **PR 10 本・深さ 3 以上をここで置く。**
 */
describe("図の中だけで、次の 1 本を選べる", () => {
  /** **10 本。** 4 本積み・3 本積み・2 本積み・1 本、で**深さ 3** を作る。 */
  const TEN: readonly PullRequestRef[] = [
    pullRequest(1, "main", "feat/a"),
    pullRequest(2, "feat/a", "feat/b"),
    pullRequest(3, "feat/b", "feat/c"),
    pullRequest(4, "feat/c", "feat/d"),
    pullRequest(5, "main", "feat/e"),
    pullRequest(6, "feat/e", "feat/f"),
    pullRequest(7, "feat/f", "feat/g"),
    pullRequest(8, "main", "feat/h"),
    pullRequest(9, "feat/h", "feat/i"),
    pullRequest(10, "main", "feat/j"),
  ];
  const TEN_EDGES = buildDependencyEdges(TEN);
  const TEN_ORDER = orderByDependency(TEN, TEN_EDGES);

  /**
   * **#8 だけが「要注意 かつ 押せる」**になるように置く。
   * **#10 は材料が届いていない**（`changes` に居ない）。
   */
  const TEN_CHANGES = new Map<number, ChangeSummary>([
    [1, change()],
    [2, change({ changedFileCount: 9, changedLineCount: 400 })],
    [3, change({ changedFileCount: 9, changedLineCount: 400 })],
    [4, change({ ciStatus: "failing" })],
    [5, change()],
    [6, change({ changedFileCount: 9, changedLineCount: 400 })],
    [7, change({ changedFileCount: 9, changedLineCount: 400 })],
    [8, change({ touchesSensitivePath: true })],
    [9, change({ changedFileCount: 9, changedLineCount: 400 })],
  ]);

  /** **図の中だけ。** 外は見ない。 */
  function figure(): string {
    const markup = render(
      props({ pullRequests: TEN, edges: TEN_EDGES, order: TEN_ORDER, changes: TEN_CHANGES }),
    );
    const from = markup.indexOf("<svg");
    expect(from, "図が出ていない").toBeGreaterThanOrEqual(0);
    const to = markup.indexOf("</svg>", from);
    expect(to, "図が閉じていない").toBeGreaterThan(from);
    return markup.slice(from, to);
  }

  /** 箱 1 つぶんの文字。 */
  function boxes(svg: string): string[] {
    return [...svg.matchAll(/<g>([\s\S]*?)<\/g>/g)].map(([, inner]) =>
      (inner ?? "")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    );
  }

  /**
   * 箱の枠が立っている列。
   *
   * **`rect` は箱の枠だけではない**（**危なさの帯も `rect`**）——**まとめて数えると
   * 列が倍に見える**ので、**いちばん広いものだけを箱として数える。**
   */
  function columnsOf(svg: string): Set<string> {
    const rects = [...svg.matchAll(/<rect x="(\d+)" y="\d+" width="(\d+)"/g)].map(
      ([, x, width]) => ({ x: x ?? "", width: Number(width) }),
    );
    expect(rects, "図に箱の枠が 1 つも無い").not.toEqual([]);
    const widest = Math.max(...rects.map((rect) => rect.width));
    return new Set(rects.filter((rect) => rect.width === widest).map((rect) => rect.x));
  }

  it("10 本すべてが、深さの違う列に並ぶ", () => {
    const svg = figure();

    expect(boxes(svg), "図に出ていない PR がある").toHaveLength(10);
    // **深さ 3 以上**（#540 の完了条件）——**列が 4 つ立つ**
    expect(columnsOf(svg).size, "深さ 3 以上の形になっていない").toBe(4);
  });

  it("1 件ごとに、危なさと何待ちかが箱に入っている", () => {
    // **どれか 1 つの箱に在ることではなく、全部の箱に在ること**を見る
    const all = boxes(figure());
    const tiered = all.filter((box) => /すぐ|通常|要注意|未判定/.test(box));
    const waiting = all.filter((box) => /押せる|待ち: #|順序不明/.test(box));

    expect(tiered, "危なさの無い箱がある").toHaveLength(10);
    expect(waiting, "何待ちかの無い箱がある").toHaveLength(10);
  });

  it("いま見るべき 1 本が、文章を読まずに絞り込める", () => {
    // **土台が 4 本（#1 #5 #8 #10）**あり、**そのうち要注意は #8 だけ**である
    // ——**「押せる」と「要注意」の重なりが 1 つに定まる**なら、目で選べている
    const all = boxes(figure());
    const next = all.filter((box) => box.includes("押せる") && box.includes("要注意"));

    expect(next, "次に見る 1 本が絞り込めない").toHaveLength(1);
    expect(next[0] ?? "", "絞り込んだ先が #8 ではない").toContain("#8");
  });

  it("材料が届いていない PR を、判定済みに見せない", () => {
    // **#10 は `changes` に居ない**——**空欄にすると「すぐ通せる」と見分けが付かない**
    const box = boxes(figure()).find((candidate) => candidate.startsWith("#10 "));

    expect(box, "#10 の箱が無い").toBeDefined();
    expect(box ?? "").toContain("未判定");
  });

  it("測っているのは図の中であって、脇の文章ではない", () => {
    // **この試験が「文章を読まずに」を測れている条件**である——**文章が混ざっていたら、
    // 箱が空でも緑になりうる**
    expect(figure(), "図の中に、脇の説明文が入り込んでいる").not.toContain(
      "いつもどおり中身を読んでください",
    );
  });
});
