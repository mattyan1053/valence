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

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DependencyEdge } from "../../domain/graph/dependency-graph";
import type { MergeBlock } from "../../domain/graph/merge-block";
import type { RiskTier } from "../../domain/triage/risk-tier";
import type { NodeMark } from "./dependency-graph-figure";
import { DependencyGraphFigure } from "./dependency-graph-figure";
import { layoutDependencyGraph } from "./graph-layout";

/** **親から受け取る**（`currentColor`）か、**塗らない**（`none`）か。 */
const FROM_PARENT = new Set(["currentColor", "none"]);

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

function mark(tier: RiskTier | undefined, block: MergeBlock = { kind: "ready" }): NodeMark {
  return { tier, block };
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
        .filter((name) => name in attrs && !FROM_PARENT.has(attrs[name] ?? ""))
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

  it("危なさは、札だけでなく濃さでも出す", () => {
    // **10 本並んだとき、札より先に目へ入るのは濃さ**である——**色は使えない**（#505。
    // **テーマが決める `currentColor` しか置けない**）ので、**段は濃さで付ける。**
    function weightOf(tier: RiskTier): string {
      // **帯は危なさが分かっている箱にだけ出る**ので、#2 を渡さなければ 1 つに定まる
      const found = [
        ...markup(new Map([[1, mark(tier)]])).matchAll(/fill-opacity="([\d.]+)"/g),
      ].map(([, value]) => value ?? "");
      expect(found, `${tier} の濃さが 1 つに定まらない`).toHaveLength(1);
      return found[0] ?? "";
    }

    expect(weightOf("high-risk"), "危なさが違うのに、同じ濃さで出ている").not.toBe(
      weightOf("fast-track"),
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
 * 「収まらない方向へ変えたときに落ちるか」**である。**全角はほぼ 1em、半角は 0.6em** で
 * 数える（**多めに見積もらない**——**見積もりが甘いほうへ倒すと、この試験が何も
 * 言わなくなる**）。
 */
describe("箱に収まっている", () => {
  const HALF_WIDTH = 0.6;

  function estimatedWidth(text: string, fontSize: number): number {
    return [...text].reduce(
      (total, character) =>
        total + fontSize * ((character.codePointAt(0) ?? 0) > 0x2e80 ? 1 : HALF_WIDTH),
      0,
    );
  }

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
        const width = estimatedWidth(text ?? "", Number(attrs["font-size"]));
        const x = Number(attrs.x);
        const left = attrs["text-anchor"] === "end" ? x - width : x;
        const y = Number(attrs.y);
        return { left, right: left + width, y, bottom: y + Number(attrs["font-size"]) / 2 };
      },
    );
    expect(labels, "箱に文字が 1 つも無い").not.toEqual([]);

    return { frame, labels };
  }

  /** **番号が 6 桁、待っている相手も 6 桁**という、いちばん長くなる形。 */
  function longest(): string {
    return markupFor(
      [123456, 234567],
      [{ dependent: 234567, dependsOn: 123456 }],
      new Map([
        [123456, mark("needs-review")],
        [234567, mark("high-risk", { kind: "depends-on", numbers: [123456, 1, 2] })],
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
