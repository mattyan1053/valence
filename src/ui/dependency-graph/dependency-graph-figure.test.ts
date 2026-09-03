/**
 * **図の色は、すべて親から受け取る**（#505）。
 *
 * **「描いた」と「読める」は別である。** **`<text>` に `fill` が無く**、**SVG の既定は黒**
 * なので、**暗いテーマでは背景と同じ色で消えていた**——**枠は `currentColor` で追随して
 * いたため**、**四角だけが見えて文字が見えない**、という形になった。
 *
 * **色の値では見ない。** **テーマが決める値は、この試験からは見えない**
 * ——**見るのは「親から受け取っているか」**である（**それが、明るいテーマでも暗い
 * テーマでも読める条件**）。**`fill` が書いてあるかだけを見ると、値が背景と同じでも通る。**
 *
 * **箱の中身も、ここで見る**（#540）。**「読める」の次は「決められる」**である
 * ——**番号しか入っていない箱は、読めても決められない。**
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DependencyEdge } from "../../domain/graph/dependency-graph";
import type { MergeBlock } from "../../domain/graph/merge-block";
import type { RiskTier } from "../../domain/triage/risk-tier";
import type { NodeMark } from "./dependency-graph-figure";
import { DependencyGraphFigure } from "./dependency-graph-figure";
import { estimateLabelWidth } from "./fit-label";
import { layoutDependencyGraph } from "./graph-layout";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** **親から受け取る**（`currentColor`）か、**塗らない**（`none`）か。 */
const FROM_PARENT = new Set(["currentColor", "none"]);

/**
 * **テーマが決める色**（#583）。**`var(--…)` は、値をここで決めていない**
 * ——**決めているのは `globals.css`** で、**そちらが明・暗の両方を持つ。**
 *
 * **守っている不変条件は「テーマが決められない色を部品が抱え込まない」**であって、
 * **単色であること自体ではない**（#505）。**ただし、片方のテーマにしか無い変数を
 * 参照すると、`var(--typo)` は透明で描かれて #505 が再発する**——**参照先が
 * 両方で定義されていることまで見る**（下の `themeVariables`）。
 */
const THEME_VARIABLE = /^var\(\s*(--[a-zA-Z0-9-]+)\s*\)$/;

function themeVariableOf(value: string): string | undefined {
  return THEME_VARIABLE.exec(value)?.[1];
}

/**
 * **テーマごとに定義されている変数の名前。**
 *
 * **明るいほうは `:root { … }`**、**暗いほうは `@media (prefers-color-scheme: dark)`
 * の中の `:root { … }`** である。**中身の値は見ない**——**見るのは「両方にあるか」**
 * だけ（**値はテーマが決めるもの**で、この試験からは正しさを言えない）。
 */
function themeVariables(): { light: Set<string>; dark: Set<string> } {
  const css = readFileSync(join(REPO_ROOT, "src/app/globals.css"), "utf8");
  const darkFrom = css.indexOf("@media (prefers-color-scheme: dark)");
  expect(darkFrom, "暗いテーマの節が globals.css に無い").toBeGreaterThanOrEqual(0);
  const names = (text: string) =>
    new Set([...text.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map(([, n]) => n ?? ""));
  return { light: names(css.slice(0, darkFrom)), dark: names(css.slice(darkFrom)) };
}

/** 塗る要素。**`g` / `title` は塗らない**ので、ここには入れない。 */
const PAINTING = new Set([
  "rect",
  "text",
  "line",
  "circle",
  "ellipse",
  "path",
  "polygon",
  "polyline",
]);

/**
 * **塗りつぶす面を持つ要素。** **`fill` の既定は黒**なので、**書かなければテーマに
 * 追随しない**——**`line` / `polyline` は面を持たない**ので、ここには入れない。
 */
const FILLABLE = new Set(["rect", "text", "circle", "ellipse", "path", "polygon"]);

type Painted = { readonly tag: string; readonly attrs: Readonly<Record<string, string>> };

/**
 * **`headKnown` の既定は「分かっている」**。**実装には既定を置いていない**
 * （**どちらへ倒しても嘘になる**）——**ここは、そこを見ない試験の書き味のためである。**
 */
function mark(
  tier: RiskTier | undefined,
  block: MergeBlock = { kind: "ready" },
  headKnown = true,
  title = "依存の図を出す",
): NodeMark {
  return { tier, block, headKnown, title };
}

/**
 * **タイトルが取れなかった箱。**
 *
 * **既定引数では作れない**——**`undefined` を渡すと既定のほうが効く**ので、
 * **「渡していない」と「取れなかった」が同じになる**（**それは #542 が消しに来た形**）。
 */
function untitled(tier: RiskTier | undefined): NodeMark {
  return { ...mark(tier), title: undefined };
}

function markupFor(
  placed: readonly number[],
  edges: readonly DependencyEdge[],
  marks: ReadonlyMap<number, NodeMark>,
): string {
  return renderToStaticMarkup(
    createElement(DependencyGraphFigure, {
      layout: layoutDependencyGraph({ placed, edges }),
      missing: { unordered: 0, unreadable: 0 },
      markOf: (number: number) => marks.get(number) ?? mark(undefined),
    }),
  );
}

/** #2 が #1 の上に積まれている、いちばん小さな図。 */
function markup(
  marks: ReadonlyMap<number, NodeMark> = new Map([
    [1, mark("high-risk")],
    [2, mark("fast-track", { kind: "depends-on", numbers: [1] })],
  ]),
): string {
  return markupFor([1, 2], [{ dependent: 2, dependsOn: 1 }], marks);
}

/**
 * **`<svg>` の中で塗っている要素**を、属性ごと取り出す。
 *
 * **図の外は見ない**（**説明文は色を指定しない**）。**1 つも見つからないなら、
 * この試験は何も見ていない**ので、そこで落とす。
 */
function painted(): Painted[] {
  const rendered = markup();
  const from = rendered.indexOf("<svg");
  expect(from, "図が出ていない").toBeGreaterThanOrEqual(0);
  const to = rendered.indexOf("</svg>", from);
  expect(to, "図が閉じていない").toBeGreaterThan(from);
  const svg = rendered.slice(from, to);

  const found: Painted[] = [];
  for (const [, tag, rest] of svg.matchAll(/<([a-zA-Z]+)([^>]*)>/g)) {
    if (!PAINTING.has(tag ?? "")) {
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const [, name, value] of (rest ?? "").matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
      attrs[name ?? ""] = value ?? "";
    }
    found.push({ tag: tag ?? "", attrs });
  }

  expect(found, "図に塗っている要素が 1 つも無い").not.toEqual([]);
  return found;
}

/**
 * 箱 1 つぶんの文字。**箱は `<g>` で 1 つにまとまっている。**
 *
 * **箱ごとに見る。** **図全体に `要注意` が在ることと、`#3` の箱に在ることは違う**
 * ——**どの箱に何が入っているかが分からないと、「1 件について目で拾える」を測れない。**
 */
function boxes(rendered: string): string[] {
  const found = [...rendered.matchAll(/<g>([\s\S]*?)<\/g>/g)].map(([, inner]) =>
    (inner ?? "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  expect(found, "図に箱が 1 つも無い").not.toEqual([]);
  return found;
}

/** **番号は箱の先頭にある。** **末尾で照合すると、`待ち: #1` の側に当たる。** */
function boxOf(rendered: string, number: number): string {
  const found = boxes(rendered).filter((box) => box.startsWith(`#${number} `));
  expect(found, `#${number} の箱が 1 つに定まらない`).toHaveLength(1);
  return found[0] ?? "";
}

describe("依存グラフの図の色", () => {
  it("塗る色は、すべて親から受け取る", () => {
    // **テーマは `color` を変える**——**`currentColor` で受ければ、明るいほうでも
    // 暗いほうでも読める。** **固定の色を置くと、片方で背景と同じになりうる。**
    const fixed = painted().flatMap(({ tag, attrs }) =>
      (["fill", "stroke"] as const)
        .filter(
          (name) =>
            name in attrs &&
            !FROM_PARENT.has(attrs[name] ?? "") &&
            themeVariableOf(attrs[name] ?? "") === undefined,
        )
        .map((name) => `${tag}: ${name}="${attrs[name]}"`),
    );

    expect(fixed, "親から受け取らない色がある").toEqual([]);
  });

  it("塗りつぶす要素は、色を書いてある", () => {
    // **書かなければ既定の黒**である (#505)——**枠は `currentColor` で追随するのに、
    // 文字だけが黒で残り**、**暗いテーマで消えた。** **「書いていない」は
    // 「テーマに追随する」ではない。**
    const bare = painted()
      .filter(({ tag }) => FILLABLE.has(tag))
      .filter(({ attrs }) => !("fill" in attrs))
      .map(({ tag }) => tag);

    expect(bare, "fill を書いていない要素がある（既定の黒で描かれる）").toEqual([]);
  });
});

describe("盤面に見た目が当たっている（#583）", () => {
  it("参照した変数は、明・暗の両方で定義されている", () => {
    // **`var(--typo)` は透明で描かれる**——**#505 が消しに来た「見えない文字」**が、
    // **綴り違いと片側だけの定義で戻る。**
    const referenced = [
      ...new Set(
        painted().flatMap(({ attrs }) =>
          (["fill", "stroke"] as const)
            .map((name) => themeVariableOf(attrs[name] ?? ""))
            .filter((name): name is string => name !== undefined),
        ),
      ),
    ];

    // **数える側が空になったことを、緑と混ぜない**——**変数を 1 つも使っていなければ、
    // この試験は何も見ていない**（**単色へ戻った日に黙る**）。
    expect(referenced, "テーマの変数を 1 つも使っていない").not.toEqual([]);

    const { light, dark } = themeVariables();
    expect(
      referenced.filter((name) => !light.has(name) || !dark.has(name)),
      "片方のテーマにしか無い変数を参照している",
    ).toEqual([]);
  });

  it("危なさは色でも拾える。札は残す", () => {
    // **濃さだけでは、並ぶと拾えない**（#583）。**色を足す**が、
    // **色だけに頼らない**——**札（すぐ / 通常 / 要注意）はそのまま残す。**
    const bandOf = (tier: RiskTier) => {
      const rendered = markupFor([1], [], new Map([[1, mark(tier)]]));
      const from = rendered.indexOf("<svg");
      const bands = [...rendered.slice(from).matchAll(/<rect[^>]*width="[56]"[^>]*>/g)].map(
        ([tag]) => /fill="([^"]*)"/.exec(tag)?.[1] ?? "",
      );
      expect(bands, `${tier} の帯が 1 本ではない`).toHaveLength(1);
      return bands[0] ?? "";
    };

    const tiers: RiskTier[] = ["fast-track", "needs-review", "high-risk"];
    const colors = tiers.map(bandOf);

    expect(new Set(colors).size, "危なさの色が見分けられない").toBe(tiers.length);
    for (const tier of tiers) {
      expect(boxOf(markupFor([1], [], new Map([[1, mark(tier)]])), 1), "札が消えている").toMatch(
        /すぐ|通常|要注意/,
      );
    }
  });

  it("箱に塗りがある", () => {
    // **枠だけの箱は、背景と地続きに見える**——**並ぶと、どこまでが 1 件か分からない。**
    const body = painted().filter(
      ({ tag, attrs }) => tag === "rect" && attrs.width !== "5" && attrs.width !== "6",
    );

    expect(body, "箱が 1 つも無い").not.toEqual([]);
    expect(
      body.filter(({ attrs }) => (attrs.fill ?? "none") === "none").map(({ attrs }) => attrs.width),
      "塗っていない箱がある",
    ).toEqual([]);
  });

  it("番号・タイトル・状態に強弱がある", () => {
    // **同じ太さ・同じ濃さで 3 行並ぶと、どれが見出しか分からない。**
    const texts = painted().filter(({ tag }) => tag === "text");
    const looks = new Set(
      texts.map(
        ({ attrs }) =>
          `${attrs["font-size"] ?? ""}/${attrs["font-weight"] ?? ""}/${attrs.fill ?? ""}`,
      ),
    );

    expect(looks.size, "文字の見た目が 1 種類しかない").toBeGreaterThanOrEqual(3);
  });
});

describe("箱の中で決められる", () => {
  it("番号・危なさ・何待ちかが、同じ箱に入る", () => {
    // **脇の文章に在ることは、箱に在ることではない**（#540）——**10 本並んだとき、
    // 目で拾えるのは箱のほうだけ**である
    const rendered = markup();

    expect(boxOf(rendered, 1), "土台の箱に危なさが無い").toContain("要注意");
    expect(boxOf(rendered, 1), "土台の箱に、押せるかどうかが無い").toContain("押せる");
    expect(boxOf(rendered, 2), "上段の箱に危なさが無い").toContain("すぐ");
    expect(boxOf(rendered, 2), "上段の箱に、何待ちかが無い").toContain("待ち: #1");
  });

  it("タイトルが、同じ箱に入る", () => {
    // **番号だけでは「どれか」が分からない**（#542）——**GitHub で引き直すことになる**
    const rendered = markup(new Map([[1, mark("high-risk", { kind: "ready" }, true, "色を直す")]]));

    expect(boxOf(rendered, 1), "箱にタイトルが無い").toContain("色を直す");
  });

  it("タイトルが取れていない PR を、短いタイトルに見せない", () => {
    // **空欄にすると「タイトルが空の PR」と見分けが付かない**（#505 / #541 と同じ向き）
    const rendered = markup(new Map([[1, untitled("high-risk")]]));

    expect(boxOf(rendered, 1)).toContain("タイトル不明");
  });

  it("長いタイトルは、切ったと分かる形で入る", () => {
    // **長さは青天井**である——**そのまま置くと隣の箱と重なる**（下の「箱に収まっている」）。
    // **黙って切ると、頭が同じ 2 本が同じ文字列になる**
    const long = "依存グラフの箱に、番号とタイトルと危なさと何待ちかを入れる";
    const rendered = markup(new Map([[1, mark("high-risk", { kind: "ready" }, true, long)]]));

    expect(boxOf(rendered, 1), "切った印が無い").toContain("…");
    expect(boxOf(rendered, 1), "切らずに置いている").not.toContain(long);
  });

  it("危なさは、札だけでなく帯でも出す", () => {
    // **10 本並んだとき、札より先に目へ入るのは帯**である（#540）。
    //
    // **段の付け方は濃さから色へ移した**（#583。**濃さ 3 段は並ぶと拾えなかった**）
    // ——**守っている不変条件は「札だけに頼らない」**で、**そこは変えていない。**
    // **色そのものが見分けられるかは、`盤面に見た目が当たっている` の側で見る。**
    function bandOf(tier: RiskTier): string {
      // **帯は危なさが分かっている箱にだけ出る**ので、#2 を渡さなければ 1 つに定まる
      const found = [...markup(new Map([[1, mark(tier)]])).matchAll(/<rect[^>]*width="6"[^>]*>/g)];
      expect(found, `${tier} の帯が 1 つに定まらない`).toHaveLength(1);
      return found[0]?.[0] ?? "";
    }

    expect(bandOf("high-risk"), "危なさが違うのに、同じ帯で出ている").not.toBe(
      bandOf("fast-track"),
    );
  });

  it("材料が届いていない PR を、判定済みに見せない", () => {
    // **空欄にすると `fast-track` と見分けが付かない**——**「安全」に倒さない**（§5）
    const rendered = markup(new Map([[1, mark(undefined)]]));

    expect(boxOf(rendered, 1)).toContain("未判定");
    expect(boxOf(rendered, 1), "材料が無いのに危なさを言っている").not.toContain("すぐ");
  });

  it("待っている相手が複数なら、件数まで言う", () => {
    // **1 本だけ出すと、残りを待っていることが消える**——**先に入れる数が分からない**
    const rendered = markup(
      new Map([[2, mark("needs-review", { kind: "depends-on", numbers: [1, 3] })]]),
    );

    expect(boxOf(rendered, 2)).toContain("待ち: #1 ほか1 件");
  });

  it("commit が分からない PR を、押せるとは言わない", () => {
    // **`head.sha` が欠けた PR は図に残る**が、**`MergeButton` は無効になる**
    // ——**札のほうが判定より広いと、無効なボタンの隣で「押せる」と言う**（#541 のレビュー）
    const rendered = markup(new Map([[1, mark("needs-review", { kind: "ready" }, false)]]));

    expect(boxOf(rendered, 1)).toContain("commit 不明");
    expect(boxOf(rendered, 1), "無効なボタンの隣で「押せる」と言っている").not.toContain("押せる");
  });

  it("依存が残っているなら、そちらを先に出す", () => {
    // **依存は先に入れれば解ける**が、**commit が分からないのは盤面を読み込み直すまで
    // 変わらない**——**次の手があるほうを出す**
    const rendered = markup(
      new Map([[2, mark("needs-review", { kind: "depends-on", numbers: [1] }, false)]]),
    );

    expect(boxOf(rendered, 2)).toContain("待ち: #1");
  });

  it("順序が決まらないものを、押せるに倒さない", () => {
    // **循環・一覧に無い番号・読めなかった PR**——**どれも押させない**（#345 / #348）
    const rendered = markup(new Map([[1, mark("needs-review", { kind: "not-orderable" })]]));

    expect(boxOf(rendered, 1)).toContain("順序不明");
    expect(boxOf(rendered, 1), "順序が決まらないのに押せると言っている").not.toContain("押せる");
  });

  it("相手の番号が無い待ちも、押せるに倒さない", () => {
    // **`mergeBlockFor` は空なら `ready` を返す**ので実際には来ないが、**型は許す**
    // ——**来たときに「押せる」へ倒れると、依存を壊す側へ倒れる**
    const rendered = markup(
      new Map([[1, mark("needs-review", { kind: "depends-on", numbers: [] })]]),
    );

    expect(boxOf(rendered, 1), "相手の分からない待ちを押せると言っている").not.toContain("押せる");
    expect(boxOf(rendered, 1), "#undefined を出している").not.toContain("undefined");
  });
});

/**
 * **書いたものが、箱に収まっているか**（#540。**#505 の次の段**）。
 *
 * **「描いた」と「読める」は別**である。**箱を広げずに 3 つ書き足すと、
 * 溢れて重なる**——**読まずに拾えるように足したものが、読めなくなる。**
 *
 * **字幅の見積もりで見る。** **本当の幅はブラウザが決める**ので、**ここで測れるのは
 * 「収まらない方向へ変えたときに落ちるか」**である。
 *
 * **見積もりは `fit-label` のものを使う**（#543 のレビュー）——**判定を 2 箇所に
 * 持たない。** **写した側が狭いままだと、切る規則を直しても、この試験は古い幅で
 * 通り続ける。** **表そのものは `fit-label.test.ts` が実フォントの字幅で留めている。**
 */
describe("箱に収まっている", () => {
  function attrsOf(rest: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (const [, name, value] of rest.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
      attrs[name ?? ""] = value ?? "";
    }
    return attrs;
  }

  type Label = {
    readonly left: number;
    readonly right: number;
    readonly y: number;
    readonly bottom: number;
  };

  /** **いちばん広い箱が枠**である（**危なさの帯も `rect`**）。 */
  function fitting(inner: string) {
    const rects = [...inner.matchAll(/<rect ([^>]*)\/?>/g)].map(([, rest]) => attrsOf(rest ?? ""));
    const frame = rects.reduce((widest, rect) =>
      Number(rect.width) > Number(widest.width) ? rect : widest,
    );

    const labels: Label[] = [...inner.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)].map(
      ([, rest, text]) => {
        const attrs = attrsOf(rest ?? "");
        const width = estimateLabelWidth(text ?? "", Number(attrs["font-size"]));
        const x = Number(attrs.x);
        const left = attrs["text-anchor"] === "end" ? x - width : x;
        const y = Number(attrs.y);
        return { left, right: left + width, y, bottom: y + Number(attrs["font-size"]) / 2 };
      },
    );
    expect(labels, "箱に文字が 1 つも無い").not.toEqual([]);

    return { frame, labels };
  }

  /**
   * **番号が 6 桁、待っている相手も 6 桁**という、いちばん長くなる形。
   *
   * **タイトルは長さが青天井**なので（#542）、**切らずに置けばここで必ず落ちる**
   * ——**この試験が、切る規則が要ることを言っている側**である。
   */
  function longest(): string {
    const longTitle = "依存グラフの箱に、番号とタイトルと危なさと何待ちかを入れる（#540 の続き）";
    return markupFor(
      [123456, 234567],
      [{ dependent: 234567, dependsOn: 123456 }],
      new Map([
        [123456, mark("needs-review", { kind: "ready" }, true, longTitle)],
        [
          234567,
          mark("high-risk", { kind: "depends-on", numbers: [123456, 1, 2] }, true, longTitle),
        ],
      ]),
    );
  }

  it("どの文字も、箱からはみ出さない", () => {
    for (const [, inner] of longest().matchAll(/<g>([\s\S]*?)<\/g>/g)) {
      const { frame, labels } = fitting(inner ?? "");
      const right = Number(frame.x) + Number(frame.width);
      const bottom = Number(frame.y) + Number(frame.height);

      for (const label of labels) {
        expect(label.left, "文字が箱の左からはみ出している").toBeGreaterThanOrEqual(
          Number(frame.x),
        );
        expect(label.right, "文字が箱の右からはみ出している").toBeLessThanOrEqual(right);
        expect(label.bottom, "文字が箱の下からはみ出している").toBeLessThanOrEqual(bottom);
      }
    }
  });

  it("上の段で、番号と危なさが重ならない", () => {
    // **番号は左寄せ、危なさは右寄せ**である——**間が無くなると、どちらも読めない**
    for (const [, inner] of longest().matchAll(/<g>([\s\S]*?)<\/g>/g)) {
      const { labels } = fitting(inner ?? "");
      // **上の段は「いちばん上に置かれたもの」**である——**高さの半分で切ると、
      // 箱を縮めたときに段の分け方まで変わり、はみ出し以外の理由で落ちる**
      const topY = Math.min(...labels.map((label) => label.y));
      const top = labels
        .filter((label) => label.y === topY)
        .sort((left, right) => left.left - right.left);

      expect(top, "上の段に 2 つ並んでいない").toHaveLength(2);
      expect(top[1]?.left ?? 0, "番号と危なさが重なっている").toBeGreaterThan(top[0]?.right ?? 0);
    }
  });
});
