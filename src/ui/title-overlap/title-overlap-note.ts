/**
 * **重複しているかもしれない PR を、行の言葉にする**（#630）。
 *
 * **「似ています」とは言わない。** **同じだった並びと、その長さを出す**
 * ——**#637 が「衝突する」と言わずに「3 個」、#639 が「遅れすぎ」と言わずに
 * 「35 遅れ」と出したのと同じ線**である。**言い切ると、重複でないものを重複と呼ぶ。**
 *
 * **判定はしない**（`fileOverlapNote` と同じ）——**`titleOverlapsFor` が返したものに、
 * 画面の語彙を当てるだけ**である。
 *
 * **境界はここが持つ。** **計算は domain、「出すかどうか」は呼ぶ側**
 * （#630 の「判断が要るところ」）——**domain は数を出すだけで、
 * どこから言うかは画面の都合**である。
 */

import type { TitleOverlapReport } from "../../domain/triage/title-overlap";

/**
 * **ここから上を出す。**
 *
 * **先に数えた**（`AGENTS.md` §4。**このリポジトリの PR 100 本、4950 組**）。
 *
 * ```
 * 同じ並びの長さ   0〜2 文字  4785 組   ← 背景（ほぼ全部の組）
 *                  9〜12 文字    3 組
 *                 32〜45 文字    4 組   ← 実際に同じ題の PR だけ
 * ```
 *
 * **背景と、実際の重複の間が広い**ので、**その谷に置く。**
 * **外すと何が起きるかは試験にある**（**境界のちょうど上と、1 つ下**）。
 *
 * **この数はこのリポジトリのもの**である（`AGENTS.md` §1。**マルチテナント**）
 * ——**別のインストール先では分布が違う。** **境界を画面側に置いたのはそのため**で、
 * **domain は数を出すだけ**にしてある（**判定を動かさずに、ここだけ動かせる**）。
 * **測った本人にしか分からないことは、残さないと消える。**
 */
export const SHARED_TITLE_FLOOR = 10;

/** その行に出す 1 文。**言うことが無ければ `undefined`。** */
export function titleOverlapNote(report: TitleOverlapReport | undefined): string | undefined {
  if (report === undefined) {
    return undefined;
  }
  const shared = report.match?.shared ?? "";
  if (shared.length < SHARED_TITLE_FLOOR) {
    // **測り切れていないなら、短くても黙らない**——**「読めなかった」を
    // 「似ていない」にしない**（#637 と同じ）
    return report.partial
      ? "タイトルを読み切れていないので、同じ題の PR を測り切れていません"
      : undefined;
  }

  const found = `タイトルが ${shared.length} 文字ぶん同じ PR: #${report.match?.number}（「${shared}」）`;
  return report.partial ? `${found}（読み切れていないので、下限です）` : found;
}
