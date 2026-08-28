/**
 * 箱に入る長さへ切る（#542）。
 *
 * **本当の幅はブラウザが決める。** ここでできるのは**見積もり**だけで、
 * **全角はほぼ 1em、半角は 0.6em** として数える（`dependency-graph-figure.test.ts` の
 * 「箱に収まっている」と同じ規則）。
 *
 * **見積もりは、狭いほうへ倒す。** **甘く見積もると、はみ出したまま通る**——
 * **切った印（`…`）も 1em で数える**（**実際は半角幅で描かれることが多い**）。
 */

/** **切ったことが分かる印。** **黙って切ると、別の PR が同じ文字列になる。** */
export const ELLIPSIS = "…";

export type FitLabelOptions = {
  /** 使ってよい幅（px）。 */
  readonly maxWidth: number;
  /** 描くときの文字の大きさ（px）。 */
  readonly fontSize: number;
};

/** **全角と半角を分ける境目。** これより上を 1em として数える。 */
const FULL_WIDTH_FROM = 0x2e80;

const HALF_WIDTH = 0.6;

function characterWidth(character: string, fontSize: number): number {
  return (character.codePointAt(0) ?? 0) > FULL_WIDTH_FROM ? fontSize : fontSize * HALF_WIDTH;
}

function estimatedWidth(text: string, fontSize: number): number {
  return [...text].reduce((total, character) => total + characterWidth(character, fontSize), 0);
}

/**
 * 入るなら**そのまま**、入らないなら**切って印を付ける**。
 *
 * **文字は書記素ではなく符号位置で数える**（`[...text]`）——**`slice` で割ると、
 * 2 つの単位でできている文字（絵文字など）が壊れて出る。**
 *
 * **印すら入らないときも、空文字を返さない**——**「取れなかった」と見分けが
 * 付かなくなる**（#542。#505 / #541 と同じ向き）。
 */
export function fitLabel(text: string, { maxWidth, fontSize }: FitLabelOptions): string {
  if (estimatedWidth(text, fontSize) <= maxWidth) {
    return text;
  }

  // **印のぶんを先に引く**——**引き忘れると、切った結果が元の幅を超える**
  const available = maxWidth - fontSize;
  const kept: string[] = [];
  let used = 0;
  for (const character of text) {
    const width = characterWidth(character, fontSize);
    if (used + width > available) {
      break;
    }
    kept.push(character);
    used += width;
  }
  return `${kept.join("")}${ELLIPSIS}`;
}
