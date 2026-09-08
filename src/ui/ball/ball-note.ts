/**
 * **ボールが誰にあるかを、行の言葉にする**（#636）。
 *
 * **判定はしない**（`RiskTierView` / `mergeReadinessNote` と同じ）——**`ballOf` が
 * 返したものに、画面の語彙を当てるだけ**である。
 *
 * **`assignmentNote`（#631）とは別の軸**である。**あちらは「誰の持ち物か（人）」**、
 * **こちらは「誰の番か（役割）」**——**誰にも振られていない PR でも、変更が
 * 求められていれば著者の番**である。
 *
 * **文言だけを持つ**（`mergeReadinessNote` と同じ形）——**器は並べる側が持つ**ので、
 * **「何も言わない」を `undefined` で表せる。**
 */

import type { Ball } from "../../domain/triage/ball";

/**
 * **`Record` で持つ。** **状態を足したときに書き忘れると型検査が落ちる**ので、
 * **名前も出ないまま画面に出る**ことが起きない（`TIER_TEXT` と同じ形）。
 *
 * **`unknown` では何も言わない。** **読めなかったものと、規則のどれにも当たらない
 * ものが入る**（`ballOf`）——**どちらも「言えることが無い」**であり、
 * **毎行に出すと読まれなくなる**（#248）。**「誰の番でもない（放置）」とは別**である
 * ——**そちらは言う。**
 */
const BALL_TEXT: Record<Ball, string | undefined> = {
  author: "著者の番です（変更が求められています）",
  merger: "マージする人の番です（承認済みで、いま入れられます）",
  reviewer: "レビューする人の番です（依頼が返っていません）",
  nobody: "誰の番でもありません（依頼もレビューもありません）",
  unknown: undefined,
};

/** その行に出す 1 文。**言うことが無ければ `undefined`。** */
export function ballNote(ball: Ball): string | undefined {
  return BALL_TEXT[ball];
}
