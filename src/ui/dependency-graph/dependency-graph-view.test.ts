import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DependencyEdge, PullRequestRef } from "../../domain/graph/dependency-graph";
import type { DependencyOrder } from "../../domain/graph/dependency-order";
import type { DependencyGraphViewProps } from "./dependency-graph-view";
import { DependencyGraphView } from "./dependency-graph-view";

/**
 * **本物の DOM を用意しない。** 見たいのは「何が画面に出るか」であって、
 * ブラウザの挙動ではない。文字列へ描けば、jsdom も testing-library も要らない。
 */
function render(props: DependencyGraphViewProps): string {
  return renderToStaticMarkup(createElement(DependencyGraphView, props));
}

/**
 * 一覧（`<ol>`）の中だけ。
 *
 * **図と一覧に、同じ `#1` / `#2` が出る** (#474 のレビュー)——**図は一覧より先に描かれる**
 * ので、**全体を見る判定は図の並びで満たされ**、**一覧の行順が逆転しても緑のまま**になる。
 * **一覧は Tier・承認・Merge が付く行**なので、**そこの並びを見る側は、ここを通す。**
 */
function list(markup: string): string {
  const from = markup.indexOf("<ol");
  expect(from, "一覧が出ていない").toBeGreaterThanOrEqual(0);
  const to = markup.indexOf("</ol>", from);
  expect(to, "一覧が閉じていない").toBeGreaterThan(from);
  return markup.slice(from, to);
}

function pullRequest(number: number, base: string, head: string): PullRequestRef {
  return {
    number,
    base: { repository: "r", branch: base },
    head: { repository: "r", branch: head },
  };
}

/** #2 が #1 の上に積まれている、いちばん小さなスタック。 */
const STACK: readonly PullRequestRef[] = [
  pullRequest(1, "main", "feat/a"),
  pullRequest(2, "feat/a", "feat/b"),
];
const STACK_EDGES: readonly DependencyEdge[] = [{ dependent: 2, dependsOn: 1 }];
const STACK_ORDER: DependencyOrder = { ordered: [1, 2], cyclic: [] };

function props(overrides: Partial<DependencyGraphViewProps> = {}): DependencyGraphViewProps {
  return {
    pullRequests: STACK,
    edges: STACK_EDGES,
    order: STACK_ORDER,
    invalid: [],
    ...overrides,
  };
}

describe("DependencyGraphView の図", () => {
  it("依存が図として出る", () => {
    // **箇条書きだけでは、深さも枝分かれも見えない** (#471)——**関係を目で追える形**が要る
    const markup = render(props());

    expect(markup, "図が出ていない").toContain("<svg");
    expect(markup, "土台と積んだものを結ぶ線が無い").toContain("<line");
  });

  it("深く積むほど、右へ置かれる", () => {
    // **置き場所は `graph-layout` が決める**（**そこは別に試験がある**）
    // ——**ここで見るのは「図に渡っているか」**である
    const deep = [...STACK, pullRequest(3, "feat/b", "feat/c")];
    const markup = render({
      ...props(),
      pullRequests: deep,
      edges: [...STACK_EDGES, { dependent: 3, dependsOn: 2 }],
      order: { ordered: [1, 2, 3], cyclic: [] },
    });

    const columns = [...markup.matchAll(/<rect x="(\d+)"/g)].map((found) => Number(found[1]));

    expect(new Set(columns).size, "3 本とも同じ列に置かれている").toBe(3);
  });

  it("図に出ていないものがあれば、図の脇で言う", () => {
    // **欠けた図を、完全な図の顔で出さない**——**循環と読めなかったぶんは図に出ない**
    const markup = render({
      ...props(),
      order: { ordered: [1], cyclic: [2] },
      invalid: [{ index: 0, reason: "base が読めない" }],
    });

    expect(markup, "図に抜けがあることが、図の脇に無い").toContain("この図には出ていないもの");
    expect(markup).toContain("並べられなかった 1 件");
    expect(markup).toContain("読めなかった 1 件");
  });

  it("すべて図に出ているなら、断らない", () => {
    // **毎回出る断りは読まれなくなる**
    const markup = render(props());

    expect(markup, "出ていないものが無いのに断っている").not.toContain("この図には出ていないもの");
  });
});

describe("DependencyGraphView", () => {
  it("土台が先、その上に積まれたものが後に出る", () => {
    // **並びは `order.ordered` が持っている。** ここで並べ替え直さない
    //
    // **見るのは一覧の中だけ** (#474 のレビュー)——**図にも同じ `#1` / `#2` が出る**ので、
    // **全体を見ると、図の並びで満たされてしまう。**
    const rows = list(
      render(props({ pullRequests: [STACK[1] as PullRequestRef, STACK[0] as PullRequestRef] })),
    );

    expect(rows.indexOf("#1")).toBeGreaterThanOrEqual(0);
    expect(rows.indexOf("#1")).toBeLessThan(rows.indexOf("#2"));
  });

  it("何の上に積まれているかが分かる", () => {
    const markup = render(props());

    expect(markup).toContain("#1");
    expect(markup).toContain("feat/b");
  });

  describe("読めなかった PR", () => {
    it("1 件でもあれば、図に抜けがあることが分かる", () => {
      // **黙って省くと、欠けた図が完全な図の顔で出る。**
      // このリポジトリが #60 / #62 / #64 / #67 / #76 / #86 で繰り返し塞いできた形
      const markup = render(props({ invalid: [{ index: 3, reason: "番号が数値ではありません" }] }));

      expect(markup).toMatch(/抜け/);
      // **何件あるかまで出す。** 「あります」だけだと、1 件なのか 20 件なのか分からない
      expect(markup).toContain("1 件");
      expect(markup).toContain("番号が数値ではありません");
    });

    it("0 件のときと見分けが付く", () => {
      // **常に同じ注意書きを出すと、出ている意味が無くなる**
      expect(render(props({ invalid: [] }))).not.toMatch(/抜け/);
    });
  });

  describe("並べられなかった PR", () => {
    it("循環に含まれる PR が画面から消えない", () => {
      // **`ordered` に入らないので、そこだけ描くと画面から消える。**
      // 「並べられなかった」であって「無い」ではない
      const markup = render(
        props({
          order: { ordered: [], cyclic: [1, 2] },
        }),
      );

      expect(markup).toContain("#1");
      expect(markup).toContain("#2");
      expect(markup).toMatch(/並べられ|循環/);
    });

    it("循環そのものだと言い切らない", () => {
      // **`cyclic` には循環に含まれない PR も入る**（その先に積まれたもの）。
      // 「循環している」と言い切ると、**半分について事実と違う**
      const markup = render(props({ order: { ordered: [], cyclic: [1, 2] } }));

      expect(markup).toMatch(/その先に積まれ/);
    });

    it("直すべき PR が分かる書き方にする", () => {
      // **その先に積まれた PR の base を付け替えても直らない。**
      // 「どれかの base を」と書くと、**言われたとおりにして無関係な PR を触る**
      const markup = render(props({ order: { ordered: [], cyclic: [1, 2] } }));

      expect(markup).toMatch(/循環している PR の base/);
      expect(markup).not.toMatch(/どれかの base/);
    });

    it("循環が無いときは、その断りを出さない", () => {
      expect(render(props())).not.toMatch(/並べられ|循環/);
    });

    it("順序にも循環にも出ない PR は、一覧から漏らさない", () => {
      // **どこにも並ばない PR が黙って消えるのを防ぐ**（順序の計算が変わっても、
      // 画面から PR が消えることは無い）
      const markup = render(props({ order: { ordered: [1], cyclic: [] } }));

      expect(markup).toContain("#2");
    });
  });

  it("1 件も無くても壊れない", () => {
    const markup = render(
      props({ pullRequests: [], edges: [], order: { ordered: [], cyclic: [] } }),
    );

    expect(markup).toMatch(/PR/);
  });
});

/**
 * **1 件も無い盤面を、誰も見ていなかった**（#410）。
 *
 * **「壊れない」は確かめてあった**（上の試験）——**が、見出しだけが出る画面でも
 * 通る。** **判定が「何も見えない画面」に届いていない**（`AGENTS.md` §4）。
 *
 * **入口の画面は、この形を既に踏んでいる**（#213: **何も見えない画面で終わらせない**）
 * ——**盤面の側は確かめられていなかった。**
 */
describe("1 件も無いとき", () => {
  const empty = (overrides: Partial<DependencyGraphViewProps> = {}) =>
    render(
      props({ pullRequests: [], edges: [], order: { ordered: [], cyclic: [] }, ...overrides }),
    );

  it("何が無いのかが出る", () => {
    expect(empty(), "空の一覧だけを出している").toMatch(/PR が 1 件もありません/);
  });

  it("次に何をすればよいのかが出る", () => {
    // **「無い」だけでは、壊れているのか、まだ何も無いのかが分からない**
    expect(empty(), "次にすることが書かれていない").toMatch(/PR を(出す|作る)/);
  });

  it("読めなかったせいで 1 件も出せないときは、0 本と言わない", () => {
    // **0 本と「読めなかった」を同じ静けさにしない**（`AGENTS.md` §5）
    // ——**「PR がありません」と出すと、読めなかったことが消える**
    const markup = empty({ invalid: [{ index: 0, reason: "base が読めません" }] });

    expect(markup, "読めなかったのに「無い」と言っている").not.toMatch(/PR を(出す|作る)/);
    expect(markup, "抜けがあることを言っていない").toMatch(/抜け/);
  });
});
