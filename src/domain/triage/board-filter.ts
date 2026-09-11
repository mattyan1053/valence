/**
 * **盤面の一覧を、誰の番かで絞る**（#663）。
 *
 * **判定は足さない。** **`ballOf`（#636）が返したものを受けて、通すか落とすかを
 * 決めるだけ**である——**#663 の本文のとおり、要るのは絞る口だけ**である。
 *
 * **既定は絞らない**（`ball` が `undefined`）。**開いた瞬間に一部しか見えていないと、
 * 見えていないことに気づけない。**
 *
 * **落とした件数を返す。** **「絞って 0 件」と「1 件も無い」は違う**（#410 が
 * `EmptyNotice` で塞いだのと同じ形）——**数を返さないと、呼ぶ側がその 2 つを
 * 言い分けられない。**
 *
 * **純粋関数である**（§3）。
 */

import type { Ball } from "./ball";

/** 絞った結果。 */
export type BoardFilterOutcome = {
  /** **通った番号。** **渡された順のまま**——**並びはここで決めない。** */
  readonly shown: readonly number[];
  /**
   * **絞りで落ちた件数。**
   *
   * **読めなかった PR は入らない**——**そちらは絞りに関係なく出す**（#663 の
   * 「気をつけること」）。**混ぜると、抜けが絞りのせいに見える。**
   */
  readonly hidden: number;
};

/**
 * **その番のものだけを通す。**
 *
 * **`ball` が `undefined` なら全部通す**（既定は絞らない）。
 */
export function filterByBall(
  rows: readonly { readonly number: number; readonly ball: Ball }[],
  ball: Ball | undefined,
): BoardFilterOutcome {
  const outcome = partitionByBall(rows, ball);
  return { shown: outcome.shown.map((row) => row.number), hidden: outcome.hidden };
}

/** 絞った結果（行そのもの）。 */
export type BoardPartition<Row> = {
  /** **通った行。** **渡された順のまま**——**並びはここで決めない。** */
  readonly shown: readonly Row[];
  /** **絞りで落ちた件数**（`BoardFilterOutcome` と同じ意味）。 */
  readonly hidden: number;
};

/**
 * **行そのものを返す絞り**（#683）。
 *
 * **番号で引けないものがある**——**横断の一覧は、別のリポジトリに同じ番号がある**
 * ので、**番号だけでは行を指せない。**
 *
 * **規則は 1 つ**（**既定は絞らない／落とした件数を返す**）。**`filterByBall` は
 * これを番号に落としたもの**である——**2 箇所に書くと、片方だけが直る**（§5）。
 */
export function partitionByBall<Row extends { readonly ball: Ball }>(
  rows: readonly Row[],
  ball: Ball | undefined,
): BoardPartition<Row> {
  if (ball === undefined) {
    return { shown: rows, hidden: 0 };
  }
  const shown = rows.filter((row) => row.ball === ball);
  return { shown, hidden: rows.length - shown.length };
}
