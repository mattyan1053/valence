import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DependencyEdge, PullRequestRef } from "../../domain/graph/dependency-graph";
import { buildDependencyEdges } from "../../domain/graph/dependency-graph";
import type { DependencyOrder } from "../../domain/graph/dependency-order";
import { orderByDependency } from "../../domain/graph/dependency-order";
import type { ChangeSummary } from "../../domain/triage/risk-tier";
import type { ReviewBoardProps } from "./review-board";
import { changeUnavailableNote, ReviewBoard } from "./review-board";

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
/**
 * **10 本並べて見た**（#597。**実物の PR は積まない**——#186。**表示の入力を作る**）。
 *
 * **数えた**——**畳む前は 67 行**（**1 件あたり 6〜8 行**）。**Tier の説明文が
 * 同じ Tier の行に何度も出て**、**「どれから見るか」を決めるのに全部読むことになった。**
 *
 * **畳む先は `RiskTierView`** で、**そちらが「何を常時出すか」を持っている**
 * ——**ここは、10 本並んだときにそれが効いているか**を見る（**1 本では、
 * 同じ文が何度も出ることそのものが起きない**）。
 */
describe("10 本並べても、順番が決まる（#597）", () => {
  const MANY: readonly PullRequestRef[] = Array.from({ length: 10 }, (_, index) =>
    pullRequest(index + 1, "main", `feat/${index + 1}`),
  );

  /** 常時見えている部分（`<summary>` の中身）を、行のぶんだけ並べる。 */
  function summaries(markup: string): readonly string[] {
    return [...markup.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>/g)].map(
      (found) => found[1] ?? "",
    );
  }

  function manyProps(): ReviewBoardProps {
    return props({
      pullRequests: MANY,
      edges: [],
      order: { ordered: MANY.map((each) => each.number), cyclic: [] },
      changes: new Map(
        MANY.map((each, index) => [
          each.number,
          change({
            changedFileCount: index + 1,
            changedLineCount: index * 40 + 5,
            // **大半は通っている**——**それが背景であることが、10 本で初めて分かる**
            ciStatus: index === 3 ? "failing" : "passing",
          }),
        ]),
      ),
    });
  }

  it("行のぶんだけ畳まれている", () => {
    const found = summaries(render(manyProps()));

    expect(found, "畳まれていない行がある").toHaveLength(MANY.length);
  });

  it("10 本とも、畳んだ状態で始まる", () => {
    // **`<summary>` の中身だけを見ると、`<details open>` にしても全部緑になる**
    // ——**67 行に戻っても気づけない**（#605 のレビュー）。**開始タグの属性を見る。**
    const markup = render(manyProps());
    const opened = [...markup.matchAll(/<details(\s[^>]*)?>/g)].map((found) => found[1] ?? "");

    expect(opened, "畳まれていない行がある").toHaveLength(MANY.length);
    for (const attributes of opened) {
      expect(attributes, "開いた状態で始まっている行がある").not.toMatch(/(^|\s)open(=|\s|$)/);
    }
  });

  it("同じ Tier の説明文が、10 回並ばない", () => {
    // **順番を決める材料にならない文が、行の数だけ出ていた。**
    const markup = render(manyProps());

    for (const summary of summaries(markup)) {
      expect(summary, "説明文が常時出ている").not.toContain("いつもどおり中身を読んでください");
    }
    // **消してはいない**——**開けば読める**（`AGENTS.md`。理由が追えること）
    expect(markup, "説明文を消している").toContain("いつもどおり中身を読んでください");
  });

  it("通っていない CI は、1 行だけ常時見える", () => {
    // **10 本のうち 1 本だけが落ちている**——**そこへ目が行かないと、順番が決まらない。**
    const shown = summaries(render(manyProps())).filter((summary) => summary.includes("CI:"));

    expect(shown, "落ちている CI が埋もれている").toHaveLength(1);
    expect(shown[0], "待つのか直すのかが読めない").toContain("直さないと進みません");
  });
});

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

describe("材料が無い理由を、同じ顔にしない（#573）", () => {
  /**
   * **「まだ取得できていません」は 3 つを 1 つにしていた**——**打ち切った / 読めなかった /
   * 本当に材料が無い。** **利用者に見えたのは全 PR で同じ 1 文**で、
   * **どれなのかはどこにも残らなかった**（記録にも出ていない）。
   *
   * **実測（2026-09-02）**: **取得は成功していて 5627 ms** かかっていた。
   * **期限は 5000 ms** なので、**毎回打ち切られていた**——**「取れなかった」ではなく
   * 「待たなかった」**である。**その 2 つが同じ文言だと、権限を疑いに行く。**
   */
  it("打ち切ったことが分かる", () => {
    expect(changeUnavailableNote("timedout")).toContain("時間");
  });

  it("読めなかったことが分かる", () => {
    expect(changeUnavailableNote("unreadable")).toContain("読め");
  });

  it("打ち切りと、読めなかったのを、同じ文にしない", () => {
    // **上の 2 つが空でないことを、ここが支えている**——**同じ文なら、
    // 分けた意味が無い**
    expect(changeUnavailableNote("timedout")).not.toBe(changeUnavailableNote("unreadable"));
  });

  it("知らない理由でも、黙らない", () => {
    // **語彙が増えたときに、行が消えないこと**（#573 の完了条件）
    expect(changeUnavailableNote("some-new-kind")).not.toBe("");
  });

  it("理由そのものは画面へ出さない", () => {
    // **`reason` には応答の値が入りうる**（`AGENTS.md` §6。#506 と同じ判断）
    // ——**受けるのは `kind` だけ**である
    for (const kind of ["timedout", "unreadable", "some-new-kind"]) {
      expect(changeUnavailableNote(kind)).not.toMatch(/expected|received|token|Bearer/i);
    }
  });
});

describe("理由が、行に出る（#577 のレビュー）", () => {
  /**
   * **文言だけを直接呼んでいた**——**`ReviewBoard` が `changeUnavailableOf` を
   * 参照して行へ出す経路は、どの試験も通っていなかった。**
   * **消して全部緑**である（#577 のレビュー）。
   *
   * **「同じ文言だったので権限を疑いに行くことになった」がこの Issue の発端**なので、
   * **言い分けが壊れても気づけないなら、同じところへ戻る。**
   */
  const props = (kind?: string): ReviewBoardProps => ({
    pullRequests: STACK,
    edges: EDGES,
    order: ORDER,
    invalid: [],
    // **材料は 1 件も無い**——**理由の側だけを変える**
    changes: new Map(),
    headKnown: () => true,
    titleOf: () => undefined,
    changeUnavailableOf: kind === undefined ? undefined : () => kind,
  });

  it("打ち切られた行は、そう出る", () => {
    expect(render(props("timedout")), "行に理由が出ていない").toContain("時間内に返りませんでした");
  });

  it("読めなかった行は、そう出る", () => {
    expect(render(props("unreadable"))).toContain("読めませんでした");
  });

  it("理由が無ければ、これまでどおり", () => {
    // **本当に材料が無い側**——**上の判定が空でないことを、ここが支えている**
    const html = render(props());

    expect(html).toContain("まだ取得できていません");
    expect(html).not.toContain("時間内に返りませんでした");
  });

  it("打ち切りと読めなかったを、行の上で取り違えない", () => {
    expect(render(props("timedout"))).not.toContain("読めませんでした");
  });
});

/**
 * **操作が縦に積まれ、幅が文字数で決まっていた**（#585 のレビュー。**人が見て言った**）。
 *
 * > approve と merge が縦にならんでて、ボタンのサイズが文字列長に影響されてズレてる
 *
 * **走らせて確かめた**（実測）。**行は `<li class="flex flex-col …">`** で、
 * **`renderActions` が返すのは `<form>` 2 つ**（`ApproveButton` / `MergeButton`）
 * ——**そのまま flex item になるので縦に積まれる。** **`<button>` の class は
 * `rounded border px-2 py-1 text-sm`** で、**幅を持たない**ので**文字幅で決まる。**
 *
 * **`<form>` は 1 つにまとめられない**（**POST 先が別**）——**横に並べる器が要る。**
 */
describe("操作が横に並ぶ（#585 のレビュー）", () => {
  /** **押すもの 2 つ**（**実物と同じく、それぞれ `<form>` を持つ**）。 */
  const ACTIONS = () =>
    createElement(
      "form",
      { action: "/approve", method: "post" },
      createElement(
        "button",
        { className: "rounded border px-2 py-1 text-sm", type: "submit" },
        "Approve",
      ),
    );

  const MORE = () =>
    createElement(
      "form",
      { action: "/merge", method: "post" },
      createElement(
        "button",
        { className: "rounded border px-2 py-1 text-sm", type: "submit" },
        "Merge",
      ),
    );

  /**
   * **その `<form>` を包んでいる器**の class。
   *
   * **開いたまま残っているものだけを見る**（#585 のレビュー）。**「直前に開いた要素」
   * だと、閉じ済みの器を返す**——**空の `ActionRow` を残して中身を後ろへ移すと、
   * 閉じた器の class が返り、判定は全部通る**（**form は縦に積まれたまま**）。
   *
   * **開始と終了を数えて、まだ閉じていない いちばん内側**を返す。
   * **1 つも開いていなければ空が返り、下の判定が落ちる。**
   */
  function wrapperOf(markup: string): string {
    const at = markup.indexOf("<form");
    expect(at, "操作が出ていない").toBeGreaterThanOrEqual(0);
    const before = markup.slice(0, at);
    const open: string[] = [];
    for (const tag of before.matchAll(/<div(?:\s+class="([^"]*)")?\s*>|<\/div>/g)) {
      if (tag[0] === "</div>") {
        open.pop();
      } else {
        open.push(tag[1] ?? "");
      }
    }
    return open[open.length - 1] ?? "";
  }

  it("押すものは、横に並ぶ", () => {
    const markup = render(
      props({
        // **実物と同じ形**——**`renderActions` は fragment を返す**（`page.tsx`）。
        // **器で包んで渡すと、測っているのは自分の器になる。**
        renderActions: (number) =>
          number === 1 ? createElement(Fragment, null, ACTIONS(), MORE()) : undefined,
      }),
    );

    const wrapper = wrapperOf(markup);

    expect(wrapper, "器が flex になっていない").toMatch(/\bflex\b/);
    expect(wrapper, "縦に積む器のままである").not.toMatch(/\bflex-col\b/);
  });

  it("押すものの幅が、文字数で決まらない", () => {
    // **「ボタンのサイズが文字列長に影響されてズレてる」**——**`Approve` と `Merge` は
    // 字数が違う**ので、**幅を書かなければ揃わない。**
    //
    // **器の側で揃える**——**`ApproveButton` と `MergeButton` は互いを知らない**ので、
    // **片方に書いても、もう片方が付いてこない。** **並ぶときに揃えるのは、並べる側の仕事。**
    const markup = render(
      props({
        // **実物と同じ形**——**`renderActions` は fragment を返す**（`page.tsx`）。
        // **器で包んで渡すと、測っているのは自分の器になる。**
        renderActions: (number) =>
          number === 1 ? createElement(Fragment, null, ACTIONS(), MORE()) : undefined,
      }),
    );

    // **子の button を名指しする variant まで見る**（#585 のレビュー）。
    // **`min-w-` がどこかに 1 度出れば通る形だと、`min-w-24` へ変えても緑**
    // ——**最小幅が付くのは器だけ**になり、**button は文字列長ごとの幅に戻る。**
    // **`&` は markup では実体参照になる**（`&amp;`）——**素の `&` で照合すると、
    // 実装が正しくても落ちる。** **緩い `min-w-` のままでは、ここに気づけなかった。**
    expect(wrapperOf(markup), "押すものの幅を揃えていない").toMatch(
      /\[&(?:amp;)?_button\]:min-w-\d/,
    );
  });

  it("状態と操作が、同じ器に入る", () => {
    // **押すものと、押した結果**は**同じ行に並ぶ**——**別々の器に入れると、
    // また縦に割れる。**
    const markup = render(
      props({
        renderStatus: (number) =>
          number === 1 ? createElement("span", null, "承認済み") : undefined,
        renderActions: (number) => (number === 1 ? ACTIONS() : undefined),
      }),
    );

    const at = markup.indexOf("承認済み");
    const form = markup.indexOf("<form");
    expect(at, "状態が出ていない").toBeGreaterThanOrEqual(0);
    expect(form, "操作が出ていない").toBeGreaterThanOrEqual(0);
    // **間で器が閉じても、開いてもいない**——**どちらでも、別の器に入っている。**
    // **閉じだけを見ると、状態を器の外へ出した形が素通りする**（変異で見つけた）。
    const between = markup.slice(at, form);
    expect(between, "状態と操作の間で器が閉じている").not.toContain("</div>");
    expect(between, "状態と操作の間で別の器が開いている").not.toContain("<div");
  });
});
