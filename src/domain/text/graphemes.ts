/**
 * **書記素で数える**（#543 のレビュー。#653 のレビュー 2 周目）。
 *
 * **符号位置ではない**——**ZWJ で繋がった絵文字は、いくつもの符号位置で 1 文字**
 * なので、**符号位置で切ると「👨‍👩‍👧」から「👨」だけが残り**、
 * **元と違う意味の文字列が出る。**
 *
 * **`String.length` でもない。** **あれは UTF-16 の数**で、**絵文字 1 個が 2** になる
 * ——**このリポジトリの PR タイトルは全部 gitmoji で始まる**ので、**必ず踏む。**
 *
 * **domain に置く**（#653 のレビュー 2 周目）。**`fit-label.ts`（ui）にあったが、
 * domain からは import できない**（§3 の依存方向）——**2 つ目を作ると、
 * 数え方が 2 箇所になる**（§5）。
 */

/**
 * **`Intl.Segmenter` は作るのが重い**ので、1 つを使い回す。
 *
 * **言語を `ja` に固定してよい。** **書記素の切れ目は言語で変わらない**
 * ——**変わるのは単語や文の切れ目**である。
 */
const SEGMENTER = new Intl.Segmenter("ja", { granularity: "grapheme" });

/** 書記素で割る。 */
export function graphemes(text: string): string[] {
  return [...SEGMENTER.segment(text)].map(({ segment }) => segment);
}

/** 書記素の数。**画面に「N 文字」と出すときの N** である。 */
export function graphemeCount(text: string): number {
  return graphemes(text).length;
}
