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

/** 一覧の行だけに割る。**行ごとに見たいものは、行の中で見る**（#621）。 */
function rowsOf(markup: string): string[] {
  return list(markup)
    .split("<li")
    .slice(1)
    .map((row) => `<li${row}`);
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
    // **既定は「分かっている」**——**この試験群が見ているのは、そこではない**
    headKnown: () => true,
    // **既定はタイトルを返す**（#542）。**同じく、ここで見るところではない**
    titleOf: (number: number) => `#${number} のタイトル`,
    // **既定は飛べる**（#621）。**この試験群が見ているのは、そこではない**
    urlOf: (number: number) => `https://github.com/o/n/pull/${number}`,
    ...overrides,
  };
}

/**
 * **見出しと本文が、同じ見た目で出ていた**（#583 のレビュー。**人が見て言った**）。
 *
 * > 行間がなかったりとか、全部左寄せになってたりとかして見づらい。
 * > あとそれぞれなんの内容が書いてあるのか段落分けもなくて見づらい
 *
 * **原因は「書いていない」こと**である。**Tailwind の preflight は
 * `h1..h6 { font-size: inherit; font-weight: inherit }` を当て**、
 * **`*` の `margin` / `padding` を 0 にする**——**配信中の CSS で確かめた。**
 * **`<h2>PR の依存</h2>` は、本文と 1 ピクセルも違わない。**
 *
 * **図の中だけ強弱を付けていた**（#583）——**画面には図の外のほうが多い。**
 */
describe("図の外にも、見た目が当たっている（#583 のレビュー）", () => {
  /** 開いているタグを、属性ごと拾う。 */
  function opening(markup: string, tag: string): string[] {
    return [...markup.matchAll(new RegExp(`<${tag}(\\s[^>]*)?>`, "g"))].map(([found]) => found);
  }

  /** **循環の節と、抜けの節も出す**——**節はそこにもある。** */
  const rendered = () =>
    render(
      props({
        order: { ordered: [1], cyclic: [2] },
        invalid: [{ index: 0, reason: "読めません" }],
      }),
    );

  /**
   * **本文より強く出ているか。**
   *
   * **`text-` では見分けられない**（変異で見つけた）——**`text-[var(--muted)]` は色**で、
   * **大きさも太さも変えない**（**弱くする側である**）。**`text-sm` も同じ向き**なので、
   * **入れない。**
   *
   * **先に数えた**——**`src/ui` と `src/app` が使っているのは
   * `text-sm` / `text-[var(--muted)]` / `text-lg` / `text-2xl` / `text-3xl` /
   * `font-bold` / `font-semibold` / `font-mono`** である。**当てたいのは、
   * 太い側と大きい側だけ。**
   */
  const STRONGER = /class="[^"]*(\bfont-(bold|semibold)\b|\btext-(lg|xl|[2-9]xl)\b)/;

  it("見出しは、本文より強く出る", () => {
    // **preflight が `inherit` へ落とすので、書かなければ本文と同じ**である。
    const headings = ["h2", "h3"].flatMap((tag) => opening(rendered(), tag));

    // **数える側が空になったことを、緑と混ぜない。**
    expect(headings, "見出しが 1 つも出ていない").not.toEqual([]);
    expect(
      headings.filter((tag) => !STRONGER.test(tag)),
      "本文と同じ見た目の見出しがある（preflight が inherit へ落とす）",
    ).toEqual([]);
  });

  it("節に余白がある", () => {
    // **`*` の margin が 0 なので、書かなければ段落は詰まって出る**
    // ——**「段落分けもなくて見づらい」の出どころ**である。
    const sections = opening(rendered(), "section");

    expect(sections, "節が 1 つも出ていない").not.toEqual([]);
    expect(
      sections.filter((tag) => !/class="[^"]*\b(gap-|space-y-)/.test(tag)),
      "中身が詰まって出る節がある",
    ).toEqual([]);
  });
});

describe("行から、その PR に辿り着ける", () => {
  // **押す場所に、何を承認するのかが書かれていない**（#621）。**人が言ったのは
  // 「なんの変更を approve / merge しようとしているのかここからじゃあまりに
  // わからなすぎる」**——**枝名は書いた人にしか読めない。**
  //
  // **図にはタイトルが出ていて、ボタンの隣の行には出ていなかった**
  // （**`titleOf` は `markOf` にだけ渡っていた**）。
  it("行にタイトルが出る", () => {
    const markup = render(props({ titleOf: (number) => (number === 1 ? "色を直す" : undefined) }));

    expect(rowsOf(markup)[0], "行にタイトルが出ていない").toContain("色を直す");
  });

  it("行から GitHub の PR へ飛べる", () => {
    // **判断が付かないときに現物を見に行く道が無いと、番号を読んで
    // 自分で URL を組み立てることになる。**
    const markup = render(props());

    expect(rowsOf(markup)[0], "PR へのリンクが無い").toContain(
      'href="https://github.com/o/n/pull/1"',
    );
  });

  it("タイトルが取れなくても、飛べる", () => {
    // **取れなかったぶんは `undefined` で来る**（#542）——**そのとき番号だけが
    // 残るが、飛べなくなってはいけない。**
    const markup = render(props({ titleOf: () => undefined }));

    expect(rowsOf(markup)[0], "PR へのリンクが無い").toContain(
      'href="https://github.com/o/n/pull/1"',
    );
  });
});

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
    // **`#1` は図の箱にも出る**（**箱には番号が入っている**）ので、**判定は一覧へ寄せる**
    // ——**全体に当てると、図が描けているだけで緑になる**（`AGENTS.md` §4）。
    const rows = list(render(props()));

    // **土台は base ブランチを、その上は土台の番号を出す**——**両方見る**
    // （**片方だけだと、全部の行を同じ形で出しても緑になる**）
    expect(rows, "何の上に積まれているかが出ていない").toContain("← #1 の上");
    expect(rows, "土台の行に、マージ先が出ていない").toContain("← main");
    expect(rows).toContain("feat/b");
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

/**
 * **図の箱だけで、次の 1 本が決まるか**（#540）。
 *
 * **「何待ちか」を書き写さない。** **判定は `mergeBlockFor`（domain）が持つ**
 * ——**Merge ボタンと同じ関数を、同じ入力で呼ぶ**ので、**画面の中で食い違わない。**
 */
describe("図の箱に、何待ちかを載せる", () => {
  /** 箱 1 つぶんの文字。**箱は `<g>` で 1 つにまとまっている。** */
  function boxes(markup: string): string[] {
    const found = [...markup.matchAll(/<g>([\s\S]*?)<\/g>/g)].map(([, inner]) =>
      (inner ?? "")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    );
    expect(found, "図に箱が 1 つも無い").not.toEqual([]);
    return found;
  }

  function boxOf(markup: string, number: number): string {
    const found = boxes(markup).filter((box) => box.startsWith(`#${number} `));
    expect(found, `#${number} の箱が 1 つに定まらない`).toHaveLength(1);
    return found[0] ?? "";
  }

  it("土台は押せる、その上は土台待ちと出る", () => {
    const markup = render(props());

    expect(boxOf(markup, 1), "土台が押せると出ていない").toContain("押せる");
    expect(boxOf(markup, 2), "何を待っているかが出ていない").toContain("待ち: #1");
  });

  it("読めなかった PR があるなら、どの箱も押せるにしない", () => {
    // **辺が作られないので、どの行の「依存なし」も信じられない**（#348 のレビュー）
    // ——**Merge ボタンと同じ判定**である
    const markup = render(props({ invalid: [{ index: 0, reason: "base が読めない" }] }));

    expect(boxOf(markup, 1)).toContain("順序不明");
    expect(boxOf(markup, 1), "抜けがあるのに押せると言っている").not.toContain("押せる");
  });

  it("危なさを渡さなければ、未判定と出る", () => {
    // **空欄にすると「すぐ通せる」と見分けが付かない**——**「安全」に倒さない**
    const markup = render(props());

    expect(boxOf(markup, 1)).toContain("未判定");
  });

  it("commit が分からない PR は、押せるとは出ない", () => {
    // **`MergeBlock` は依存の順序しか知らない**（#541 のレビュー）
    // ——**押せるかどうかは、渡す側から受ける**
    const markup = render(props({ headKnown: (number) => number !== 1 }));

    expect(boxOf(markup, 1)).toContain("commit 不明");
    expect(boxOf(markup, 1), "commit が分からないのに押せると言っている").not.toContain("押せる");
  });

  it("渡されたタイトルが、その箱に出る", () => {
    // **番号だけの箱では「どれか」が分からない**（#542）——**GitHub で引き直すことになる**
    const markup = render(props({ titleOf: (number) => (number === 1 ? "色を直す" : undefined) }));

    expect(boxOf(markup, 1), "箱にタイトルが無い").toContain("色を直す");
    expect(boxOf(markup, 2), "取れていないタイトルを、空欄で出している").toContain("タイトル不明");
  });

  it("渡された危なさが、その箱に出る", () => {
    const markup = render(props({ tierOf: (number) => (number === 1 ? "high-risk" : undefined) }));

    expect(boxOf(markup, 1)).toContain("要注意");
    expect(boxOf(markup, 2), "渡していない PR にまで危なさを出している").toContain("未判定");
  });
});

/**
 * **本数が増えても、画面が固まらない**（#540 の完了条件。**#120 / #158 で踏んでいる**）。
 *
 * **ここで測れるのは「描き切って返る」までである**（#541 のレビュー）。
 * **2 乗になっていないことは、ここでは測れない**——**300 本のとき、辺と順序をなめ直す
 * ぶんは React の描画に埋もれる**ので、**線形と 2 乗が同じ顔で通る。**
 * **判定の側は domain で測っている**（`merge-block.test.ts` の
 * 「本数が増えても、2 乗にならない」。**10000 件で、1 件ずつ呼ぶ形は 50 秒かかる**）。
 */
describe("本数が増えたとき", () => {
  it("300 本でも、描き切って返る", () => {
    const many = Array.from({ length: 300 }, (_, index) =>
      pullRequest(index + 1, index === 0 ? "main" : `feat/${index}`, `feat/${index + 1}`),
    );
    const edges: DependencyEdge[] = many
      .slice(1)
      .map((request) => ({ dependent: request.number, dependsOn: request.number - 1 }));

    const started = process.hrtime.bigint();
    const markup = render({
      ...props(),
      pullRequests: many,
      edges,
      order: { ordered: many.map((request) => request.number), cyclic: [] },
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(markup, "300 本目が出ていない").toContain("#300");
    // **上限は緩く取る**——**見たいのは「返ってくる」ことだけ**で、
    // **機械の混み具合で落ちる試験は、読まれなくなる**
    expect(elapsedMs, `描くのに ${elapsedMs}ms かかっている`).toBeLessThan(3000);
  });
});
