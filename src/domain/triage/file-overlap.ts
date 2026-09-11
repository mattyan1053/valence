/**
 * **同じファイルを触る open PR を、組として出す**（#637）。
 *
 * **依存グラフは base/head の積み重ねしか見ない。** **base が別々でも、同じファイルに
 * 触っていれば、順序が要ることがある**——**先にどちらかが入ると、もう片方は
 * 取り込み直しが要るかもしれない。**
 *
 * **「要る」とは言い切らない** (#651 のレビュー 2 周目)——**同じファイルでも離れた行なら、
 * git が黙って合流させる。** **重なりが言えるのは「調整が要るかもしれない」まで**で、
 * **それは下の「衝突するとは言わない」と同じ線**である。**強く書くと、後から読む人が
 * 実装の意図を取り違える。**
 *
 * **いまは依存が無ければ「押せる」と出て、その手掛かりが 1 つも無い。**
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

export type OverlapReports = {
  /**
   * **この盤面の数が、どれも下限か。**
   *
   * **盤面ぜんたいの事実である**（#702）——**どれか 1 本でも測り切れていなければ立つ**
   * （自分の側でも、相手の側でも）。**一覧が見切れている**か、**材料そのものが
   * 取れていない**か、**一覧から読めなかった**か。**どれも「見えていないパスが
   * 重なっているかもしれない」**である。**「測れなかった」を「重なっていない」に
   * しない**（#637。**このリポジトリが繰り返し塞いでいる形**）。
   *
   * **行に持たせない**（#702）——**行ごとに違わない値を行が持つと、**
   * **画面がそれを行ごとに言う**（**12 行の盤面で、同じ 1 文が 12 回出ていた**）。
   *
   * **相手ごとにも分けない。** **見切れた PR とは、そもそも比べ切れていない**ので、
   * **「この相手とは正確」と言える範囲が、行の側からは決められない。**
   */
  readonly partial: boolean;
  /** **行ごとの事実。** **重なっている相手**——**多い順、同じなら番号の小さい順。** */
  readonly rows: ReadonlyMap<number, readonly FileOverlap[]>;
};

/**
 * **1 枚の盤面で数える、重なりの回数。**
 *
 * **かかりは「共有しているパスに何本が乗っているか」で決まる** (#651 のレビュー)
 * ——**`pnpm-lock.yaml` を全 PR が触れば、本数の 2 乗**である。**素のままだと
 * 盤面が開かない**（**行が 1 つ黙るのとは違う**）。
 *
 * **数えて決めた** (#656。**このコンテナで実測**)。
 * **全部が同じ 20 パスを触る 1000 本で 4.7 秒**、**2000 本で 18.4 秒**だった。
 *
 * **切る側だけでなく、通す側も数えた**——**このリポジトリの PR 100 本は、
 * 触ったパスが 1 本あたり中央 4 個・最大 21 個で、組は合計 1890**である。
 * **同じ形なら 1000 本でも 189,000** で、**ここには届かない。**
 * **上限を低く置くと、ふつうの盤面が毎回「下限です」になる。**
 *
 * **1 組あたり約 360 ナノ秒**（**250 本 × 20 パス = 1,245,000 組で 446 ms**）
 * ——**この上限でのかかりは 0.4 秒ほど**である。
 *
 * **区切ったぶんは `partial` で言う**——**黙って切らない**（#653 と同じ語彙）。
 * **先の行から順に使う**ので、**使い切ったあとの行は数が小さく出る**
 * ——**どの行も「下限です」と言う**のはそのためである。
 */
const OVERLAP_BUDGET = 1_000_000;

/**
 * **一覧ぶんをまとめて出す**（`mergeBlocksFor` と同じ理由）。
 *
 * **1 件ずつ比べると本数の 2 乗**になる——**盤面は全部の行について呼ぶ。**
 * **パスから引く索引を 1 度だけ作る。**
 *
 * **それでも「パスの総数で決まる」とは言えない** (#651 のレビュー)——
 * **かかりは「共有しているパスに何本が乗っているか」で決まる。**
 * **`pnpm-lock.yaml` を全 PR が触れば、組の数は本数の 2 乗**である。
 * **上限がある**（`OVERLAP_BUDGET`。#656 で測ってから入れた）——**区切ったぶんは
 * `partial` で言う。** **黙って切ると、この Issue が消しに来た状態
 * （順序に影響する相手が見えない）に戻る。** **行が読めなくなる話は #597 の仕事**である。
 *
 * **訊いた PR は、重なりが無くても全部返る**——**行が消えると、
 * 測ったのかどうかが分からない。**
 */
export function fileOverlapsFor(
  /**
   * **一覧から読めなかった PR の件数**（#651 のレビュー 3 周目）。
   *
   * **候補には混ぜない。** **検証に落ちた PR は番号が読めない**（`InvalidPullRequest`
   * は `index` で持つ）——**番号の無いものは候補にできない。**
   *
   * **既定値を置かない**（`mergeBlockFor` の `unreadableCount` と同じ理由）——
   * **書き忘れが「抜けは無い」へ倒れると、この判定がまるごと素通りする。**
   */
  unreadableCount: number,
  candidates: readonly OverlapCandidate[],
): OverlapReports {
  // **先に集合へ落とす**（#651 のレビュー）——**`ChangedPaths.paths` は一意ではない。**
  // **`toChangeSummary` は `filename` と `previous_filename` を並べる**ので、
  // **`A → B` と `B → C` を 1 本でやると `[B, A, C, B]` になる**（**ディレクトリを
  // 整理する PR でふつうに起きる**）。**そのまま数えると、1 個しか共有していないのに
  // 2 個と出て、多い順の並びまで変わる。**
  const pathsOf = new Map<number, ReadonlySet<string>>(
    candidates.map((candidate) => [candidate.number, new Set(candidate.changedPaths?.paths ?? [])]),
  );

  const byPath = new Map<string, number[]>();
  for (const candidate of candidates) {
    for (const path of pathsOf.get(candidate.number) ?? []) {
      const found = byPath.get(path);
      if (found === undefined) {
        byPath.set(path, [candidate.number]);
      } else {
        found.push(candidate.number);
      }
    }
  }

  // **`partial` より先に数える**——**区切ったかどうかは、数えてみるまで分からない**
  const budget = { left: OVERLAP_BUDGET, spent: false };
  const overlaps = new Map(
    candidates.map((candidate) => [
      candidate.number,
      overlapsOf(candidate.number, pathsOf.get(candidate.number), byPath, budget),
    ]),
  );

  // **1 本でも測り切れていなければ、どの行の数も下限である**（`OverlapReports.partial`）
  const partial =
    // **読めなかった PR は、そもそも一覧に出てこない**——**触ったパスも分からない**
    unreadableCount > 0 ||
    candidates.some(
      (candidate) => candidate.changedPaths === undefined || candidate.changedPaths.truncated,
    ) ||
    budget.spent;

  return {
    partial,
    rows: new Map(
      candidates.map((candidate) => [candidate.number, overlaps.get(candidate.number) ?? []]),
    ),
  };
}

function overlapsOf(
  number: number,
  // **集合を受ける**——**数えるのはファイルの重なりであって、行の数ではない**
  paths: ReadonlySet<string> | undefined,
  byPath: ReadonlyMap<string, readonly number[]>,
  budget: { left: number; spent: boolean },
): readonly FileOverlap[] {
  const counts = new Map<number, number>();
  for (const path of paths ?? []) {
    for (const other of byPath.get(path) ?? []) {
      // **自分自身とは重ねない**——**予算を見るより先に外す** (#660 のレビュー)。
      // **自分自身は予算を使わない**ので、**先に予算を見ると、上限ちょうどで
      // 残りが自分自身だけのときに「区切った」と言う**——**1 件も落としていない**
      if (other === number) {
        continue;
      }
      if (budget.left <= 0) {
        // **区切ったことは `partial` で言う**——**黙って切らない**（#656）
        budget.spent = true;
        return ranked(counts);
      }
      budget.left -= 1;
      counts.set(other, (counts.get(other) ?? 0) + 1);
    }
  }

  return ranked(counts);
}

/** **多い順、同じなら番号の小さい順**——**呼ぶたびに揺れると、理由が読めない。** */
function ranked(counts: ReadonlyMap<number, number>): readonly FileOverlap[] {
  return [...counts]
    .map(([number, count]) => ({ number, count }))
    .sort((left, right) => right.count - left.count || left.number - right.number);
}
