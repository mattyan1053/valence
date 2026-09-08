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

import type { OverlapReport } from "../../domain/triage/file-overlap";

/**
 * その行に出す 1 文。**言うことが無ければ `undefined`。**
 *
 * **測り切れていないことは、重なりが見えなくても言う**——**「測れなかった」を
 * 「重なっていない」にしない**（#637。**このリポジトリが繰り返し塞いでいる形**）。
 */
export function fileOverlapNote(report: OverlapReport | undefined): string | undefined {
  if (report === undefined) {
    return undefined;
  }
  if (report.overlaps.length === 0) {
    return report.partial
      ? "変更ファイルの一覧を読み切れていないので、同じファイルを触る PR を測り切れていません"
      : undefined;
  }

  const pairs = report.overlaps
    .map((overlap) => `#${overlap.number}（${overlap.count} 個）`)
    .join(", ");
  // **見切れているなら、その数は下限である**
  return report.partial
    ? `同じファイルを触っている PR: ${pairs}（読み切れていないので、下限です）`
    : `同じファイルを触っている PR: ${pairs}`;
}
