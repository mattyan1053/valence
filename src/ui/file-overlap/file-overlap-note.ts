/**
 * **同じファイルを触る PR を、行の言葉にする**（#637）。
 *
 * **「衝突する」とは言わない。** **同じファイルでも、離れた行なら衝突しない**
 * ——**言い切ると、避けなくてよい順序を押し付ける。** **数を出すところまでにする**
 * （#639 が「遅れすぎ」と言わずに数を出すのと同じ）。
 *
 * **判定はしない**（`mergeReadinessNote` と同じ）——**`fileOverlapsFor` が返した
 * ものに、画面の語彙を当てるだけ**である。
 *
 * **言うことが無ければ黙る**（#248）。**行はもう長い**（#597）——**重なりが無く、
 * かつ測り切れているなら、この行は毎回同じことを言うだけである。**
 */

import type { FileOverlap } from "../../domain/triage/file-overlap";

/**
 * その行に出す 1 文。**言うことが無ければ `undefined`。**
 *
 * **測り切れていないことは、盤面が 1 回だけ言う**（#702。`fileOverlapLimitNote`）
 * ——**`partial` は盤面ぜんたいの事実**で、**行ごとに違わない。**
 * **12 行の盤面で、同じ 1 文が 10 回出ていた。**
 *
 * **「測れなかった」を「重なっていない」にしない**のは変わらない（#637）
 * ——**言う場所が、行から盤面へ移っただけ**である。
 */
export function fileOverlapNote(overlaps: readonly FileOverlap[] | undefined): string | undefined {
  if (overlaps === undefined || overlaps.length === 0) {
    return undefined;
  }

  const pairs = overlaps.map((overlap) => `#${overlap.number}（${overlap.count} 個）`).join(", ");
  return `同じファイルを触っている PR: ${pairs}`;
}

/**
 * **盤面に 1 回だけ出す断り**（#702）。
 *
 * **理由は名指さない**（#656）——**`OverlapReports.partial` は真偽値 1 つ**で、
 * **一覧が見切れていたのか、材料が取れなかったのか、一覧から読めなかったのか、
 * 組が多すぎて区切ったのか（`OVERLAP_BUDGET`）を持っていない。**
 * **名指すと、当たっていないほうを言う。**
 */
export function fileOverlapLimitNote(partial: boolean): string | undefined {
  return partial ? "同じファイルを触る PR を測り切れていません" : undefined;
}
