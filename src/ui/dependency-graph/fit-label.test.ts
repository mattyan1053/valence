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
import { ELLIPSIS, estimateLabelWidth, fitLabel } from "./fit-label";

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

    expect(estimateLabelWidth(fitted, 11)).toBeLessThanOrEqual(maxWidth);
  });

  it("半角のほうが多く入る", () => {
    // **全角と半角を同じ幅で数えると、英語のタイトルが必要以上に切られる**
    const half = fitLabel("abcdefghijklmnopqrstuvwxyz", { maxWidth: 44, fontSize: 11 });
    const full = fitLabel("あいうえおかきくけこさしすせそ", { maxWidth: 44, fontSize: 11 });

    expect([...half].length).toBeGreaterThan([...full].length);
  });

  it("細い半角は、ふつうの半角より多く入る", () => {
    // **`i` と `a` を同じ幅で数えると、細い字が並ぶタイトルが必要以上に切られる**
    // ——**広いほうへ倒すのは溢れを防ぐため**であって、**全部を広く見るためではない**
    const narrow = fitLabel("i".repeat(40), { maxWidth: 44, fontSize: 11 });
    const ordinary = fitLabel("a".repeat(40), { maxWidth: 44, fontSize: 11 });

    expect([...narrow].length).toBeGreaterThan([...ordinary].length);
  });

  it("実フォントより狭く見積もらない", () => {
    // **見積もりの表そのものを、実フォントの字幅で留める**（#543 のレビュー）。
    // **狭く見積もると、切らずに返したものが実際には箱を越える**——**その回帰は、
    // 幅の性質を見る試験では捕まらない**（**判定も見積もりで動く**ため）。
    //
    // **参照値は Arial**（1000 単位の字幅を em に直したもの）。**フォントは指定して
    // いない**ので、**閲覧環境ではこれより広いこともある**——**だから上限として使う。**
    const reference: ReadonlyArray<readonly [string, number]> = [
      ["@", 1.015],
      ["W", 0.944],
      ["m", 0.889],
      ["M", 0.833],
      ["A", 0.667],
      ["1", 0.556],
      ["あ", 1],
    ];

    for (const [character, em] of reference) {
      expect(
        estimateLabelWidth(character, 100),
        `${character} を実フォントより狭く見積もっている`,
      ).toBeGreaterThanOrEqual(em * 100);
    }
  });

  it("gitmoji の付いたタイトルを、狭く見積もらない", () => {
    // **このリポジトリの PR タイトルに実際に出る文字**である（#543 のレビュー）
    // ——**`✨ ♻ ✅ ⬆ §` はどれも `U+2E80` 未満**なので、**全角の側に入らない。**
    // **`0.62em` で数えると、絵文字が並んだタイトルが箱に「入る」と読まれる。**
    for (const character of "✨♻✅⬆§") {
      expect(
        estimateLabelWidth(character, 100),
        `${character} を半角として数えている`,
      ).toBeGreaterThanOrEqual(100);
    }

    const title = "✨".repeat(15);
    expect(fitLabel(title, { maxWidth: 150, fontSize: 11 })).not.toBe(title);
  });

  it("いちばん広い半角が並んでも、切らずには返さない", () => {
    // **一律 0.6em で数えると、`W` が 22 個で 145px と読み**、**150px の箱に
    // そのまま入れてしまう**——**実際は 200px を越えて隣の箱と重なる**（#543 のレビュー）
    const wide = "W".repeat(22);

    expect(fitLabel(wide, { maxWidth: 150, fontSize: 11 })).not.toBe(wide);
  });

  it("印すら入らないなら、印だけを返す", () => {
    // **空文字を返さない**——**「取れなかった」と見分けが付かなくなる**（#542）
    expect(fitLabel("あいうえお", { maxWidth: 1, fontSize: 11 })).toBe(ELLIPSIS);
  });

  it("ZWJ で繋がった絵文字を、途中で割らない", () => {
    // **家族の絵文字は、3 つの絵文字と 2 つの ZWJ でできている**——**符号位置で
    // 数えて切ると、男性だけが残って別の意味になる**（#543 のレビュー）
    const family = "👨‍👩‍👧";
    const fitted = fitLabel(family.repeat(4), { maxWidth: 120, fontSize: 11 });

    const kept = graphemes(fitted).filter((character) => character !== ELLIPSIS);
    expect(kept, "書記素の途中で切っている").not.toEqual([]);
    expect(
      kept.every((character) => character === family),
      `割れている: ${fitted}`,
    ).toBe(true);
  });

  it("2 文字で 1 つの文字を、途中で割らない", () => {
    // **絵文字や異体字は 2 つの単位でできている**——**`slice` で割ると壊れた文字が出る**
    const fitted = fitLabel("🐛🐛🐛🐛🐛🐛🐛🐛", { maxWidth: 44, fontSize: 11 });

    // **半分だけ残った単位は、それ自身では文字にならない**
    // （**`\ud83d` を `toContain` で見ると、割れていない対でも当たる**）
    const kept = [...fitted].filter((character) => character !== ELLIPSIS);
    expect(kept, "1 文字も残っていない").not.toEqual([]);
    expect(
      kept.every((character) => character === "🐛"),
      `割れている: ${fitted}`,
    ).toBe(true);
  });
});

/**
 * **書記素で割る。** **符号位置ではない**——**ZWJ で繋がった絵文字は、
 * いくつもの符号位置で 1 文字になる。**
 */
function graphemes(text: string): string[] {
  return [...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(text)].map(
    ({ segment }) => segment,
  );
}
