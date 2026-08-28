/**
 * **箱に入る長さへ切る**（#542）。
 *
 * **タイトルは長さが青天井**である。**切らずに置くと、隣の箱と重なって
 * どちらも読めなくなる**——**#541 で入れた「箱に収まっている」検査が見ている形。**
 *
 * **切ったことが分かる形にする。** **黙って切ると、`fix: 依存グラフの色` と
 * `fix: 依存グラフの色が暗いテーマで消える` が、箱の上では同じ文字列になる。**
 */

import { describe, expect, it } from "vitest";
import { ELLIPSIS, fitLabel } from "./fit-label";

describe("箱に入る長さへ切る", () => {
  it("入るものは、そのまま返す", () => {
    expect(fitLabel("短い", { maxWidth: 100, fontSize: 11 })).toBe("短い");
  });

  it("入らないものは、切ったと分かる形で返す", () => {
    const fitted = fitLabel("あいうえおかきくけこさしすせそ", { maxWidth: 44, fontSize: 11 });

    expect(fitted.endsWith(ELLIPSIS), `切った印が無い: ${fitted}`).toBe(true);
    expect(fitted, "切っていない").not.toBe("あいうえおかきくけこさしすせそ");
  });

  it("切ったあとも、箱に収まっている", () => {
    // **印のぶんを数え忘れると、切った結果が元より広くなる**
    const maxWidth = 44;
    const fitted = fitLabel("あいうえおかきくけこさしすせそ", { maxWidth, fontSize: 11 });

    expect(estimatedWidth(fitted, 11)).toBeLessThanOrEqual(maxWidth);
  });

  it("半角のほうが多く入る", () => {
    // **全角と半角を同じ幅で数えると、英語のタイトルが必要以上に切られる**
    const half = fitLabel("abcdefghijklmnopqrstuvwxyz", { maxWidth: 44, fontSize: 11 });
    const full = fitLabel("あいうえおかきくけこさしすせそ", { maxWidth: 44, fontSize: 11 });

    expect([...half].length).toBeGreaterThan([...full].length);
  });

  it("印すら入らないなら、印だけを返す", () => {
    // **空文字を返さない**——**「取れなかった」と見分けが付かなくなる**（#542）
    expect(fitLabel("あいうえお", { maxWidth: 1, fontSize: 11 })).toBe(ELLIPSIS);
  });

  it("2 文字で 1 つの文字を、途中で割らない", () => {
    // **絵文字や異体字は 2 つの単位でできている**——**`slice` で割ると壊れた文字が出る**
    const fitted = fitLabel("🐛🐛🐛🐛🐛🐛🐛🐛", { maxWidth: 44, fontSize: 11 });

    // **半分だけ残った単位は、それ自身では文字にならない**
    // （**`\ud83d` を `toContain` で見ると、割れていない対でも当たる**）
    expect(
      [...fitted].filter((character) => character !== ELLIPSIS),
      "文字が割れている",
    ).toEqual(Array.from({ length: 3 }, () => "🐛"));
  });
});

/** **この試験が持つ見積もり。** **実装と同じ規則だが、こちらが判定の側である。** */
function estimatedWidth(text: string, fontSize: number): number {
  return [...text].reduce(
    (total, character) => total + fontSize * ((character.codePointAt(0) ?? 0) > 0x2e80 ? 1 : 0.6),
    0,
  );
}
