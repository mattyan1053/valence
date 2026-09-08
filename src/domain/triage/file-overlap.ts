/**
 * **同じファイルを触る open PR を、組として出す**（#637）。
 *
 * **依存グラフは base/head の積み重ねしか見ない。** **base が別々でも、同じファイルに
 * 触っていれば実質的に順序がある**——**先にどちらかが入ると、もう片方は取り込み直しが要る。**
 * **いまは依存が無ければ「押せる」と出る。**
 *
 * **「衝突する」とは言わない。** **同じファイルでも、離れた行なら衝突しない**
 * ——**言い切ると、避けなくてよい順序を押し付ける**（#637 の「気をつけること」）。
 * **数を出すところまでにする**（#639 が「遅れすぎ」と言わずに数を出すのと同じ）。
 *
 * **依存の順序と混ぜない**（`review-board.tsx` の判断）。**依存は守らないと壊れる制約**、
 * **ファイルの重なりは目安**である——**盤面の並びは変えない。**
 *
 * **#630（重複の検知）とは別物である。** **あちらは「同じことを 2 回やっている」**で、
 * **こちらは「別のことだが、順序に影響する」**——**混ぜると、正しく分割された
 * 積み重ねを「重複」と呼ぶ。**
 *
 * **純粋関数である**（§3）。
 */

import type { ChangedPaths } from "./risk-tier";

/** 比べる材料 1 件ぶん。 */
export type OverlapCandidate = {
  readonly number: number;
  /**
   * **見えた範囲のパスと、見切れたか**（#642）。**両方要る。**
   *
   * **材料そのものが取れていないなら `undefined`。** **「触っていない」ではない**
   * ——**空の一覧として渡すと、その PR とは重ならないと言うことになる。**
   */
  readonly changedPaths: ChangedPaths | undefined;
};

/** 重なっている相手 1 件。 */
export type FileOverlap = {
  readonly number: number;
  /** **見えた範囲で重なっているパスの数。** */
  readonly count: number;
};

export type OverlapReport = {
  /** **重なっている相手。** **多い順、同じなら番号の小さい順。** */
  readonly overlaps: readonly FileOverlap[];
  /**
   * **この数が下限か。**
   *
   * **どれか 1 本でも測り切れていなければ立つ**（自分の側でも、相手の側でも）
   * ——**一覧が見切れている**か、**材料そのものが取れていない**か。
   * **どちらも「見えていないパスが重なっているかもしれない」**である。
   * **「測れなかった」を「重なっていない」にしない**（#637。**このリポジトリが
   * 繰り返し塞いでいる形**）。
   *
   * **相手ごとに分けない。** **見切れた PR とは、そもそも比べ切れていない**ので、
   * **「この相手とは正確」と言える範囲が、行の側からは決められない。**
   */
  readonly partial: boolean;
};

/**
 * **一覧ぶんをまとめて出す**（`mergeBlocksFor` と同じ理由）。
 *
 * **1 件ずつ比べると本数の 2 乗**になる——**盤面は全部の行について呼ぶ。**
 * **パスから引く索引を 1 度だけ作る**ので、**触ったパスの総数で決まる。**
 *
 * **訊いた PR は、重なりが無くても全部返る**——**行が消えると、
 * 測ったのかどうかが分からない。**
 */
export function fileOverlapsFor(
  candidates: readonly OverlapCandidate[],
): ReadonlyMap<number, OverlapReport> {
  const byPath = new Map<string, number[]>();
  for (const candidate of candidates) {
    for (const path of candidate.changedPaths?.paths ?? []) {
      const found = byPath.get(path);
      if (found === undefined) {
        byPath.set(path, [candidate.number]);
      } else {
        found.push(candidate.number);
      }
    }
  }

  // **1 本でも測り切れていなければ、どの行の数も下限である**（`OverlapReport.partial`）
  const partial = candidates.some(
    (candidate) => candidate.changedPaths === undefined || candidate.changedPaths.truncated,
  );

  return new Map(
    candidates.map((candidate) => [
      candidate.number,
      { overlaps: overlapsOf(candidate, byPath), partial },
    ]),
  );
}

function overlapsOf(
  candidate: OverlapCandidate,
  byPath: ReadonlyMap<string, readonly number[]>,
): readonly FileOverlap[] {
  const counts = new Map<number, number>();
  for (const path of candidate.changedPaths?.paths ?? []) {
    for (const other of byPath.get(path) ?? []) {
      // **自分自身とは重ねない**
      if (other !== candidate.number) {
        counts.set(other, (counts.get(other) ?? 0) + 1);
      }
    }
  }

  // **多い順、同じなら番号の小さい順**——**呼ぶたびに揺れると、理由が読めない**
  return [...counts]
    .map(([number, count]) => ({ number, count }))
    .sort((left, right) => right.count - left.count || left.number - right.number);
}
