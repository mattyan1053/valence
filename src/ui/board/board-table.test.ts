/**
 * **列の規則は、器が 1 箇所で持つ**（#717。**表が 2 つになった**）。
 *
 * **判定だけを取り出して見る**（`AGENTS.md` §4）——**盤面越しでは、束ねた旗と
 * 分けた旗が同じ色になる**（**本物の材料では、桁を揃える列と折り返さない列が
 * ほぼ重なっている**）。**#724 のレビューが踏んだのは、まさにそこ**である。
 */

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
