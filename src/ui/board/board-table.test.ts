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
function cellsWithoutRule(text: string): readonly string[] {
  const code = text
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(line))
    .join("\n");
  return [...code.matchAll(/<(td|th)\b[^>]*>/g)]
    .map(([tag, name]) => ({ tag, name: `<${name}` }))
    .filter(({ tag }) => !/\bcolSpan\b/.test(tag) && !/scope="col"/.test(tag))
    .filter(({ tag }) => !tag.includes("boardCellClass("))
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
