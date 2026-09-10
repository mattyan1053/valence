/**
 * **誰の番かで絞る口**（#663 / #667）。**画面の語彙だけを持つ。**
 *
 * **判定はしない**（`ballNote` と同じ）——**通すかどうかは絞る側が決める。**
 *
 * **受ける値と、出す選択肢を 1 つの並びから作る。** **離すと、画面に無い絞りを
 * URL で選べる**（**その逆も起きる**）——**`?ball=` は誰でも好きな文字列を
 * 入れられる**ので、**並べたものだけを通す**（`approveNoticeKind` と同じ判断。#330）。
 *
 * **絞る口（#663 / PR #666）とは別の周回で入る。** **こちらが足すのは運ぶ側**
 * ——**どちらが先に入っても壊れない**（**知らない値は「絞らない」へ落ちる**）。
 */

import type { Ball } from "../../domain/triage/ball";

/**
 * **画面が出す絞り込み。**
 *
 * **`unknown` は出さない。** **読めなかったものと、規則のどれにも当たらないものが
 * 入る**（`ballOf`）——**`ballNote` が何も言わない側**であり、
 * **選んでも「何の集まりか」が言えない。**
 *
 * **`Ball` の一部であることを型で縛る**（`satisfies`）——**縛らないと、
 * 打ち間違えた選択肢が「どの行にも当たらない絞り」として静かに出る**（#185 の形）。
 */
export const BALL_FILTERS = [
  "author",
  "reviewer",
  "merger",
  "nobody",
] as const satisfies readonly Ball[];

/** 出す選択肢の 1 つ。**`Ball` の一部である。** */
export type BallFilter = (typeof BALL_FILTERS)[number];

/**
 * **URL の値を、絞り込みへ落とす。** **分からなければ絞らない。**
 *
 * **同じ鍵が 2 つ載っていたら絞らない**（配列で来る）——**片方を選ぶと、
 * URL と画面が食い違う。**
 */
export function ballFilterOf(
  value: string | readonly string[] | undefined,
): BallFilter | undefined {
  return BALL_FILTERS.find((ball) => ball === value);
}
