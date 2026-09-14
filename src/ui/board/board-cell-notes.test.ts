/**
 * **表の 1 マスに出す文**（#716）。
 *
 * **短くする**——**比べるための表**なので、**行の散文をそのまま入れると横に潰れる**
 * （#714 の注意）。**「読めなかった」を空欄にしない**のは、そのままである（§5）。
 */

import { describe, expect, it } from "vitest";
import {
  activeDaysCellNote,
  ciCellNote,
  dependsOnCellNote,
  sizeCellNote,
} from "./board-cell-notes";

describe("CI の列", () => {
  it("状況を、短い語で出す", () => {
    expect(ciCellNote("passing")).toBe("通った");
    expect(ciCellNote("pending")).toBe("実行中");
    expect(ciCellNote("failing")).toBe("落ちた");
  });

  it("材料が無ければ、空欄にしない", () => {
    // **空欄は「CI が無い」と見分けが付かない**（§5）。
    expect(ciCellNote(undefined)).toBe("読めません");
  });
});

describe("サイズの列", () => {
  it("ファイル数と行数を、1 マスに出す", () => {
    expect(sizeCellNote({ files: 3, lines: 42 })).toBe("3 ファイル / 42 行");
  });

  it("材料が無ければ、空欄にしない", () => {
    expect(sizeCellNote(undefined)).toBe("読めません");
  });
});

describe("active 日数の列", () => {
  it("日数を出す", () => {
    expect(activeDaysCellNote(0)).toBe("今日");
    expect(activeDaysCellNote(1)).toBe("1 日前");
    expect(activeDaysCellNote(30)).toBe("30 日前");
  });

  it("読めなければ、空欄にしない", () => {
    // **0 日（今日）へ倒さない**——**`activeDaysSince` が「分からない」を返す側**である。
    expect(activeDaysCellNote(undefined)).toBe("読めません");
  });
});

describe("依存 PR 数の列", () => {
  it("本数を出す", () => {
    expect(dependsOnCellNote(0)).toBe("0");
    expect(dependsOnCellNote(2)).toBe("2");
  });
});
