/**
 * **誰の番かで絞る口**（#663 / #667）。**画面の語彙だけを持つ。**
 *
 * **判定はしない**（`ballNote` と同じ）——**通すかどうかは `filterByBall` が決める。**
 *
 * **受ける値と、出す選択肢を 1 つの並びから作る。** **離すと、画面に無い絞りを
 * URL で選べる**（**その逆も起きる**）——**`?ball=` は誰でも好きな文字列を
 * 入れられる**ので、**並べたものだけを通す**（`approveNoticeKind` と同じ判断。#330）。
 *
 * **運ぶ側（#667）と絞る側（#663）が、ここで揃った。** **知らない値は
 * 「絞らない」へ落ちる**ので、**どちらが先に入っても壊れなかった。**
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
 * **短い名前。** **`Record` で持つ**ので、**選択肢を足して書き忘れると型検査が落ちる**
 * （`BALL_TEXT` と同じ形）。
 *
 * **行の文（`ballNote`）とは別**である——**あちらは 1 件の説明**、**こちらは束の名前。**
 */
const FILTER_LABEL: Record<BallFilter, string> = {
  author: "著者の番",
  reviewer: "レビューする人の番",
  merger: "マージする人の番",
  nobody: "誰の番でもない",
};

export function ballFilterLabel(ball: BallFilter): string {
  return FILTER_LABEL[ball];
}

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

/**
 * **いま絞っていることを言う 1 文。** **絞っていなければ `undefined`。**
 *
 * **隠した件数を必ず出す**（#663）——**絞られていることに気づけないと、
 * 見えていないものに気づけない。** **隠した件数が 0 でも言う**
 * ——**「全部が当てはまった」と「絞っていない」は違う。**
 *
 * **通ったものが 0 件なら、そう言う**（#410 が `EmptyNotice` で塞いだ形）
 * ——**一覧が空のまま隠した件数だけ言っても、当てはまるものが無いのか、
 * 読み落としたのかが分からない。**
 */
export function ballFilterNote(
  ball: BallFilter | undefined,
  counts: { readonly shown: number; readonly hidden: number },
): string | undefined {
  if (ball === undefined) {
    return undefined;
  }
  const label = ballFilterLabel(ball);
  const hidden = `${counts.hidden} 件を隠しています`;
  return counts.shown === 0
    ? `「${label}」の PR はありません（${hidden}）`
    : `「${label}」だけを出しています（${hidden}）`;
}
