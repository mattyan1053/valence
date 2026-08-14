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
 * **だから短くてよい。** **総和で 0.5 秒**——**それを超えて現れないなら、
 * 勝った側は保存に失敗している**（**待っても現れない**）。
 */

import type { WaitForWinnersSave } from "../../application/auth/ensure-usable-token";

/** 既定の間合い。**総和 0.5 秒**（**画面を止めてよい上限**として決めた）。 */
const DEFAULT_DELAYS_MS = [50, 150, 300];

export type WaitForWinnersSaveOptions = {
  readonly delaysMs?: readonly number[];
  /** **差し替えるための引数であって、抽象ではない**（#64 と同じ形）。 */
  readonly sleep?: (ms: number) => Promise<void>;
};

export function createWaitForWinnersSave({
  delaysMs = DEFAULT_DELAYS_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: WaitForWinnersSaveOptions = {}): WaitForWinnersSave {
  return async (attempt: number) => {
    const delay = delaysMs[attempt - 1];
    if (delay === undefined) {
      // **尽きた。** **待たずに打ち切る**——**ここで待つと、諦めるのに時間がかかる**
      return false;
    }
    await sleep(delay);
    return true;
  };
}
