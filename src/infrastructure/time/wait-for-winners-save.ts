/**
 * **更新に負けた側が、勝った側の保存を待つ間合い** (#214)。
 *
 * **待つことそのものは副作用**なので、**infrastructure に置く**（§3）。
 * **`ensureUsableToken` は時間を知らない**——**何回待てるかだけを訊く。**
 *
 * **待つ根拠。** **窓は `save` 1 回ぶん**（DB へ 1 往復）である。**負けた側が
 * 失敗を知るのは GitHub へ 1 往復したあと**なので、**普通は勝った側が先に
 * 終わっている**——**待つのは、順序が入れ替わった稀な場合のためだけ**である。
 *
 * **数えるのは「実際に止まっている時間」である** (#254 のレビュー)。
 * **間合いの合計だけを数えると、上限が上限にならない**——**読み直しは
 * `store.load()` の往復を伴う**ので、**置き場が遅い日には、間合いより往復のほうが
 * 長い。** **`load → 待つ → load → …` の全体が予算の中に収まる**ようにする。
 *
 * **測れるのはここだけ。** **この関数は読み直しの「間」に呼ばれる**ので、
 * **呼ばれた時刻の差が、往復にかかった時間そのもの**である。
 */

import type { WaitForWinnersSave } from "../../application/auth/ensure-usable-token";

/** **画面を止めてよい上限。** **待ちも読み直しも、ここに収める。** */
const DEFAULT_BUDGET_MS = 500;

/** 間合い。**予算が尽きれば、残っていても使わない。** */
const DEFAULT_DELAYS_MS = [50, 150, 300];

export type WaitForWinnersSaveOptions = {
  readonly budgetMs?: number;
  readonly delaysMs?: readonly number[];
  /** **差し替えるための引数であって、抽象ではない**（#64 と同じ形）。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * いまを測る口。**`sleep` と同じ扱いにする** (#131 / #137)——
   * **差し替えられれば、試験は本物の時計を回さずに締切を確かめられる。**
   */
  readonly now?: () => number;
};

export function createWaitForWinnersSave({
  budgetMs = DEFAULT_BUDGET_MS,
  delaysMs = DEFAULT_DELAYS_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
}: WaitForWinnersSaveOptions = {}): WaitForWinnersSave {
  // **最初に訊かれた時刻から数える。** **その前の 1 回目の `load` は、待つと
  // 決める前に必ず起きる**ので、**「待ちのために止めた時間」には入れない。**
  let startedAt: number | undefined;

  return async (attempt: number) => {
    // **時計は 1 回だけ読む。** **2 回読むと、その間に進んだぶんが
    // 「往復にかかった時間」に混ざる**——**測りたいのは呼ばれた時刻の差である。**
    const askedAt = now();
    startedAt ??= askedAt;
    const remaining = budgetMs - (askedAt - startedAt);
    if (remaining <= 0) {
      // **予算を使い切った。** **間合いが残っていても待たない**——
      // **往復が遅い日は、ここで回数が自然に減る。**
      return false;
    }

    const delay = delaysMs[attempt - 1];
    if (delay === undefined) {
      // **尽きた。** **待たずに打ち切る**——**ここで待つと、諦めるのに時間がかかる**
      return false;
    }

    // **はみ出さない。** **残りより長い間合いは、残りに切り詰める。**
    await sleep(Math.min(delay, remaining));
    return true;
  };
}
