/**
 * **列の規則は、器が 1 箇所で持つ**（#717。**表が 2 つになった**）。
 *
 * **判定だけを取り出して見る**（`AGENTS.md` §4）——**盤面越しでは、束ねた旗と
 * 分けた旗が同じ色になる**（**本物の材料では、桁を揃える列と折り返さない列が
 * ほぼ重なっている**）。**#724 のレビューが踏んだのは、まさにそこ**である。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { boardCellClass } from "./board-table";

describe("マスに当てる規則（#717）", () => {
  it("数字の列は、桁を揃える", () => {
    // **揃わないと、比べるために読むことになる**（#714 の注意）。
    expect(boardCellClass("size")).toMatch(/\btabular-nums\b/);
    expect(boardCellClass("active")).toMatch(/\btabular-nums\b/);
    expect(boardCellClass("depends-on")).toMatch(/\btabular-nums\b/);
  });

  it("桁を揃えない列もある", () => {
    // **当たらない入力を隣に置く**——**全部に付けても緑になる形にしない。**
    expect(boardCellClass("pull-request")).not.toMatch(/\btabular-nums\b/);
    expect(boardCellClass("ci")).not.toMatch(/\btabular-nums\b/);
    expect(boardCellClass("actions")).not.toMatch(/\btabular-nums\b/);
  });

  it("短い語の列は、折り返さない", () => {
    // **桁揃えとは別の理由である**（#724 のレビュー）——**`読めません` が文字ごとに
    // 折り返すと、CI の列が潰れる。** **`overflow-x-auto` は効かない**
    // （**表そのものが縮む**）。
    //
    // **1 つの旗に束ねて、片方を落とした**——**分けてある。**
    expect(boardCellClass("ci"), "CI の列が折り返す").toMatch(/\bwhitespace-nowrap\b/);
    expect(boardCellClass("size")).toMatch(/\bwhitespace-nowrap\b/);
    expect(boardCellClass("active")).toMatch(/\bwhitespace-nowrap\b/);
    expect(boardCellClass("depends-on")).toMatch(/\bwhitespace-nowrap\b/);
  });

  it("折り返してよい列もある", () => {
    // **タイトルは長い**——**折り返さないと、横に伸び続ける。**
    expect(boardCellClass("pull-request"), "タイトルの列が折り返さない").not.toMatch(
      /\bwhitespace-nowrap\b/,
    );
    expect(boardCellClass("actions")).not.toMatch(/\bwhitespace-nowrap\b/);
  });

  it("どの列にも、線と余白が当たる", () => {
    // **1 マスの器は 1 箇所で決める**——**列ごとに書くと揃わない。**
    for (const column of [
      "pull-request",
      "ci",
      "size",
      "active",
      "depends-on",
      "actions",
    ] as const) {
      expect(boardCellClass(column), `${column} に器が当たっていない`).toMatch(/\bborder-t\b/);
    }
  });
});

/**
 * **マスの class を、器を通さずに書けてしまう**（#725）。
 *
 * **#724 の中で 2 回踏んだ。** **どちらも「器は在るが、通っていない」**である。
 *
 * 1. **CI のマスが、移す途中で規則を落とした**——**旗を 1 つに束ねたので、
 *    `whitespace-nowrap` が非数字の側へ落ちた**
 * 2. **PR の列が、そもそも結線されていなかった**——**`COLUMNS["pull-request"]` は
 *    在るのに、両方の表が `BOARD_CELL` を直接書いていた**
 *
 * **いまの試験では、2 を戻しても赤くならない**——**`pull-request` は両方の旗が
 * `false`** なので、**`boardCellClass("pull-request")` と `BOARD_CELL` は同じ文字列**
 * である。**規則が 1 つ入った瞬間から効くが、それまでは黙る。**
 *
 * **前例は `<h2>` の走査**（`board-section.test.ts`）——**同じ手**である。
 */

const SRC_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** **器そのもの。** **`boardCellClass` の実装がここに在る**ので、走査から外す。 */
const RULE = join("ui", "board", "board-table.tsx");

/** `src` 以下の、試験でない `.tsx`。**マスを描くのは `.tsx` だけ**である。 */
function sourceFiles(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    if (!entry.name.endsWith(".tsx") || entry.name.endsWith(".test.tsx")) {
      return [];
    }
    return [path];
  });
}

/**
 * **器を通さずに描いているマスを拾う**（#725）。
 *
 * **前例は `<h2>` の走査**（`board-section.test.ts`）——**判定は試験の側に置く。**
 * **本番の部品に、本番が呼ばない関数を置かない**（`AGENTS.md` §5）。
 *
 * **`BOARD_CELL` を禁じてはいない。** **見るのは「マスが器に訊いたか」だけ**である
 * ——**器の中では使う**（`boardCellClass` の実装がそれ）。
 *
 * **列に属さないマスは対象外**（`colSpan` / `scope="col"`）——**段をまたぐマスは、
 * どれか 1 つの列のものではない**（**理由の段、行の中身の段、見出しの段**）。
 *
 * **行で割らない** (#720 のレビュー)——**`<h2>` の走査は、行末で切れた開きタグを
 * 見落としていた。** **開きタグは複数行にまたがる**ので、**タグごと取る。**
 * **散文は先に落とす**（`AGENTS.md` §4。**このリポジトリは理由を厚く書く**ので、
 * **`<td>` は説明にも出る**）。
 *
 * **返すのは、拾ったタグの名前**（`<td` / `<th`）——**何件あったかが読める。**
 */
/**
 * **開きタグの終わり**（`>` の位置）。
 *
 * **引用符と波括弧の外にある `>` で決める** (#726 のレビュー)——**`[^>]*` は
 * 式の中の `>` で止まる**（`<td aria-label={count > 0 ? …} className={…}>`）。
 * **止まると、その先の `className` も `colSpan` も見えない**ので、
 * **器を通しているマスが「通していない」と出る。**
 *
 * **閉じが見つからなければ、残り全部を返す**——**黙って落とさない**（§5）。
 */
const QUOTES = new Set(['"', "'", "`"]);

/** 1 文字読んだあとの、引用符と波括弧の深さ。 */
function stepped(
  state: { readonly quote: string | undefined; readonly depth: number },
  letter: string,
): { readonly quote: string | undefined; readonly depth: number } {
  if (state.quote !== undefined) {
    return { quote: letter === state.quote ? undefined : state.quote, depth: state.depth };
  }
  if (QUOTES.has(letter)) {
    return { quote: letter, depth: state.depth };
  }
  if (letter === "{") {
    return { quote: undefined, depth: state.depth + 1 };
  }
  return { quote: undefined, depth: letter === "}" ? state.depth - 1 : state.depth };
}

function tagEnd(code: string, from: number): number {
  let state: { readonly quote: string | undefined; readonly depth: number } = {
    quote: undefined,
    depth: 0,
  };
  for (let at = from; at < code.length; at += 1) {
    const letter = code[at] ?? "";
    if (letter === ">" && state.quote === undefined && state.depth === 0) {
      return at + 1;
    }
    state = stepped(state, letter);
  }
  return code.length;
}

/**
 * **`className` の値の終わり。**
 *
 * **波括弧か引用符の対応で決める**——**`tagEnd` と同じ規則**である（`stepped`）。
 */
function valueEnd(tag: string, from: number): number {
  let state: { readonly quote: string | undefined; readonly depth: number } = {
    quote: undefined,
    depth: 0,
  };
  for (let at = from; at < tag.length; at += 1) {
    state = stepped(state, tag[at] ?? "");
    if (at > from && state.quote === undefined && state.depth === 0) {
      return at + 1;
    }
  }
  return tag.length;
}

/**
 * **そのマスの class が、器から来ているか** (#726 のレビュー 2 周目)。
 *
 * **判定の範囲は `className` の値まで**（`AGENTS.md` §4）——**タグ全体を見ると、
 * 別の属性から呼んだだけでも、片方の枝だけ器を迂回していても通る**
 * （`<td className={compact ? BOARD_CELL : boardCellClass("ci")}>`）。**これは偽の緑**で、
 * **前の 2 件（偽の赤）と違って誰も気づかない。**
 *
 * **守りたいのは「どの枝も器から来ていること」**である。**そのままは書けない**ので、
 * **近いところで止める**——**器を呼んでいて、かつ `BOARD_CELL` が混ざっていない。**
 *
 * **`className` が無いマスも、器から来ていない**（**ただの文字列も同じ**）。
 */
function usesRule(tag: string): boolean {
  const at = tag.indexOf("className=");
  if (at === -1) {
    return false;
  }
  const from = at + "className=".length;
  const value = tag.slice(from, valueEnd(tag, from));
  return value.includes("boardCellClass(") && !value.includes("BOARD_CELL");
}

function cellsWithoutRule(text: string): readonly string[] {
  const code = text
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(line))
    .join("\n");
  return [...code.matchAll(/<(td|th)\b/g)]
    .map((found) => ({
      name: `<${found[1]}`,
      tag: code.slice(found.index, tagEnd(code, found.index)),
    }))
    .filter(({ tag }) => !/\bcolSpan\b/.test(tag) && !/scope="col"/.test(tag))
    .filter(({ tag }) => !usesRule(tag))
    .map(({ name }) => name);
}

describe("マスは、器を通して描く（#725）", () => {
  it("器を通さずにマスを描いている場所が無い", () => {
    // **既知のファイルだけに狭めない**——**捕まえたいのは、次に表を足した人**である。
    // **数えた**: **`<td>` / `<th>` を書いているのは 3 ファイル**
    // （依存の表・推奨レビュー順・器）で、**器は走査から外している。**
    const written = sourceFiles(SRC_ROOT)
      .map((path) => ({
        path: path.slice(SRC_ROOT.length),
        cells: cellsWithoutRule(readFileSync(path, "utf8")),
      }))
      .filter((found) => found.path !== RULE && found.cells.length > 0);

    expect(
      written,
      `器を通さずに描いているマスがある: ${written.map((one) => `${one.path} ${one.cells.join(" ")}`).join(" / ")}`,
    ).toEqual([]);
  });

  it("列に属さないマスは、器を通さなくてよい", () => {
    // **段をまたぐマス**（理由の段・行の中身の段）**は、どれか 1 つの列のものではない。**
    expect(cellsWithoutRule('<td className="px-3 pb-2" colSpan={COLUMNS.length}>')).toEqual([]);
    expect(
      cellsWithoutRule('<th className={`${BOARD_CELL} text-left`} colSpan={4} scope="rowgroup">'),
    ).toEqual([]);
    // **見出しの段も列そのものではない**（器が描いている）
    expect(cellsWithoutRule('<th className="px-3 py-1 font-normal" scope="col">')).toEqual([]);
  });

  it("器を通していれば、拾わない", () => {
    expect(cellsWithoutRule('<td className={boardCellClass("ci")}>')).toEqual([]);
    expect(
      cellsWithoutRule(
        '<th className={`${boardCellClass("pull-request")} text-left`} scope="row">',
      ),
    ).toEqual([]);
  });

  it("器を通していなければ、拾う", () => {
    // **旗が全部 `false` でも赤くなる**——**`BOARD_CELL` と同じ文字列を返す日でも**である
    // （**そこが、結線の試験では測れていなかったところ**）。
    expect(cellsWithoutRule("<td className={BOARD_CELL}>")).toEqual(["<td"]);
    expect(cellsWithoutRule('<th className={`${BOARD_CELL} text-left`} scope="row">')).toEqual([
      "<th",
    ]);
  });

  it("属性の中の `>` で、タグを切らない", () => {
    // **`[^>]*` は式の中の `>` で止まる**（#726 のレビュー）——**その先の
    // `boardCellClass` が見えず、器を通しているマスが「通していない」と出る。**
    //
    // **現物にはまだ 0 件**（**数えた**）だが、**このリポジトリは JSX の式に `>` を書く**
    // （`assignment-summary-view.tsx` ほか）——**マスの属性に 1 つ入った日に赤くなり**、
    // **しかも「器を通していない」と言う。** **読んだ人は走査を緩めるほうへ倒れる。**
    expect(
      cellsWithoutRule(
        '<td aria-label={count > 0 ? "あり" : "なし"} className={boardCellClass("ci")}>',
      ),
      "器を通しているのに拾った",
    ).toEqual([]);
    expect(
      cellsWithoutRule('<td aria-label={count > 0 ? "あり" : "なし"} className={BOARD_CELL}>'),
      "器を通していないのに見逃した",
    ).toEqual(["<td"]);
    // **除外の判定も、同じところで切れる**
    expect(
      cellsWithoutRule(
        '<td aria-label={count > 0 ? "あり" : "なし"} colSpan={2} className={BOARD_CELL}>',
      ),
      "段をまたぐマスの除外が効いていない",
    ).toEqual([]);
  });

  it("判定は、`className` の値まで", () => {
    // **タグのどこかに 1 回でも出れば合格していた**（#726 のレビュー 2 周目）
    // ——**`boardCellClass(` を別の属性から呼んでも、片方の枝だけ器を迂回しても、通る。**
    //
    // **これは偽の緑である**（**前の 2 件は偽の赤**）——**誰も気づかない。**
    // **`className` に三項は現物に 0 件**だが、**この書き方はこのリポジトリに既にある**
    // （`approval-badge.tsx` / `review-board.tsx`）。
    expect(
      cellsWithoutRule('<td className={compact ? BOARD_CELL : boardCellClass("ci")}>'),
      "器を迂回する枝があるのに通した",
    ).toEqual(["<td"]);
    expect(
      cellsWithoutRule('<td title={boardCellClass("ci")} className={BOARD_CELL}>'),
      "別の属性から呼んだだけで通した",
    ).toEqual(["<td"]);
    expect(cellsWithoutRule('<td className="px-3">'), "器を通っていないのに通した").toEqual([
      "<td",
    ]);
    // **当たらない入力を隣に置く**——**全部挙げても緑、にならない形**
    expect(cellsWithoutRule('<td className={boardCellClass("ci")}>')).toEqual([]);
  });

  it("折り返した開きタグも拾う", () => {
    // **`<h2>` の走査は、行末で切れた開きタグを見落としていた**（#720 のレビュー）
    // ——**同じ形の穴を、こちらでは行で割らないことで塞ぐ。**
    expect(
      cellsWithoutRule(
        '      <th\n        className={`${BOARD_CELL} text-left`}\n        scope="row"\n      >',
      ),
    ).toEqual(["<th"]);
  });

  it("説明の散文に書いても、拾わない", () => {
    // **このリポジトリは理由を厚く書く**（`AGENTS.md` §4）——**`<td>` は散文にも出る。**
    expect(cellsWithoutRule(" * **`<td className={BOARD_CELL}>` と書かない**")).toEqual([]);
    expect(cellsWithoutRule("// <th className={BOARD_CELL}> は器を通っていない")).toEqual([]);
    expect(cellsWithoutRule("      {/* <td> のこと */}")).toEqual([]);
  });

  it("閉じタグは拾わない", () => {
    // **`</td>` は開きタグではない**——**当たると、全部の行が赤くなる。**
    expect(cellsWithoutRule("</td>\n</th>")).toEqual([]);
  });
});
