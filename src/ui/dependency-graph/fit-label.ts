/**
 * 箱に入る長さへ切る（#542）。
 *
 * **本当の幅はブラウザが決める。** **フォントを指定していない**ので、**閲覧環境で
 * 変わる**——**ここでできるのは見積もりだけ**である。
 *
 * **見積もりは広いほうへ倒す**（#543 のレビュー）。**狭く見積もると、切らずに返した
 * ものが実際には箱を越え、隣の箱と重なる**——**溢れる側へ倒すと、この道具の目的
 * そのものが消える。** **少し早く切るのは読めるが、重なった 2 つは読めない。**
 */

/** **切ったことが分かる印。** **黙って切ると、別の PR が同じ文字列になる。** */
export const ELLIPSIS = "…";

export type FitLabelOptions = {
  /** 使ってよい幅（px）。 */
  readonly maxWidth: number;
  /** 描くときの文字の大きさ（px）。 */
  readonly fontSize: number;
};

/**
 * **半角の表が当てはまる範囲。** **ASCII の外は、すべて 1em として数える**
 * （#543 のレビュー）——**`✨ ♻ ✅ ⬆ §` は `U+2E80` 未満**だが、**このリポジトリの
 * PR タイトルに実際に出る**（**gitmoji の件名**）。
 *
 * **`é` `ü`（Arial で 0.556em）まで 1em になり、必要以上に切る**——**そちらを取った。**
 * **言語ごとに表を増やすのは、この道具の範囲を越える**（**この PR で決めたのはここまで**）。
 */
const ASCII_MAX = 0x7f;

/**
 * 半角の字幅（em）。**Arial の字幅を上限側へ丸めたもの**である。
 *
 * **一律にしない。** **`0.6em` で揃えると `@WMmw` が実物より狭くなり**、
 * **`0.6` より広い側で揃えると、英語のタイトルが必要以上に切られる。**
 */
const WIDTH = {
  /** `@` は Arial で 1.015em——**全角より広い。** */
  wide: 1.05,
  /** 大文字。**`W` `M` を除いた上限は 0.778em。** */
  upper: 0.8,
  /** `i` `l` などの細いもの。**上限は 0.333em（`r`）。** */
  narrow: 0.4,
  /** 小文字と数字。**上限は 0.611em。** */
  other: 0.62,
} as const;

const WIDE = new Set([..."@WMmw%&"]);
const NARROW = new Set([..."iljItfr.,;:'\"!|()[]{} -"]);

function characterWidth(character: string, fontSize: number): number {
  if ((character.codePointAt(0) ?? 0) > ASCII_MAX) {
    return fontSize;
  }
  if (WIDE.has(character)) {
    return fontSize * WIDTH.wide;
  }
  if (NARROW.has(character)) {
    return fontSize * WIDTH.narrow;
  }
  if (character >= "A" && character <= "Z") {
    return fontSize * WIDTH.upper;
  }
  return fontSize * WIDTH.other;
}

/**
 * **書記素で割る**（#543 のレビュー）。**符号位置ではない**——**ZWJ で繋がった
 * 絵文字は、いくつもの符号位置で 1 文字**なので、**符号位置で切ると
 * 「👨‍👩‍👧」から「👨」だけが残り**、**元と違う意味の文字列が出る。**
 */
const SEGMENTER = new Intl.Segmenter("ja", { granularity: "grapheme" });

function graphemes(text: string): string[] {
  return [...SEGMENTER.segment(text)].map(({ segment }) => segment);
}

/**
 * 見積もった幅（px）。**判定はここ 1 箇所が持つ**（`AGENTS.md` §5）。
 *
 * **書記素の幅は、その中の符号位置の合計**とする——**実物より広い**が、
 * **広いほうへ倒すのがこの道具の向き**である。
 */
export function estimateLabelWidth(text: string, fontSize: number): number {
  return [...text].reduce((total, character) => total + characterWidth(character, fontSize), 0);
}

/**
 * 入るなら**そのまま**、入らないなら**切って印を付ける**。
 *
 * **印すら入らないときも、空文字を返さない**——**「取れなかった」と見分けが
 * 付かなくなる**（#542。#505 / #541 と同じ向き）。
 */
export function fitLabel(text: string, { maxWidth, fontSize }: FitLabelOptions): string {
  if (estimateLabelWidth(text, fontSize) <= maxWidth) {
    return text;
  }

  // **印のぶんを先に引く**——**引き忘れると、切った結果が元の幅を超える**
  const available = maxWidth - fontSize;
  const kept: string[] = [];
  let used = 0;
  for (const grapheme of graphemes(text)) {
    const width = estimateLabelWidth(grapheme, fontSize);
    if (used + width > available) {
      break;
    }
    kept.push(grapheme);
    used += width;
  }
  return `${kept.join("")}${ELLIPSIS}`;
}
