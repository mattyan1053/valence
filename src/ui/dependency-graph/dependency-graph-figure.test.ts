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
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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

/** #2 が #1 の上に積まれている、いちばん小さな図。 */
function markup(): string {
  const layout = layoutDependencyGraph({
    placed: [1, 2],
    edges: [{ dependent: 2, dependsOn: 1 }],
  });
  return renderToStaticMarkup(
    createElement(DependencyGraphFigure, {
      layout,
      missing: { unordered: 0, unreadable: 0 },
    }),
  );
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
