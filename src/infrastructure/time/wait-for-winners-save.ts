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
 * 長い。** **予算は、待ちだけでなく、その間に挟まる往復も食う**ようにする
 * （**全部を収めるわけではない。何を数えていないかは `DEFAULT_BUDGET_MS` にある**）。
 *
 * **測れるのはここだけ。** **この関数は読み直しの「間」に呼ばれる**ので、
 * **呼ばれた時刻の差が、往復にかかった時間そのもの**である。
 */

import type { WaitForWinnersSave } from "../../application/auth/ensure-usable-token";
import { createTimeBudget, type TimeBudget } from "./time-budget";

/**
 * **待ちに使ってよい上限。**
 *
 * **数えているのは「訊かれた時刻の差」**である——**間合いそのものと、
 * その間に挟まる読み直しの往復**が入る。
 *
 * **読み直しの往復も、この予算の中で切れる** (#255)。**置き場は残りを覗き、
 * 自分の制限と短いほうで諦める**ので、**「返ってこない 1 回の往復」で
 * 予算が破れることはない**（**渡すのは `createSupabaseUserTokenStore` の
 * `remainingMs`**。束ねるのは合成ルート）。
 *
 * **数えていないものが 1 つある** (#254 のレビュー)。**待つと決める前に起きる
 * 1 回目の `load`** である——**測るのは呼ばれたときだけ**なので、そこは入らない。
 * **止まったままにはならない**（**置き場が自分の時間制限で諦める**）が、
 * **その時間はこの予算の外側で足される。**
 */
const DEFAULT_BUDGET_MS = 500;

/** 間合い。**予算が尽きれば、残っていても使わない。** */
const DEFAULT_DELAYS_MS = [50, 150, 300];

/**
 * **待ちの予算を作る。**
 *
 * **外から作れるようにしてある** (#255)——**同じ 1 つを、置き場と分け合う**
 * （**別々に作ると、それぞれが自分の時刻から数え、合計は上限を超える**）。
 */
export function createWinnersSaveBudget(now?: () => number): TimeBudget {
  return createTimeBudget({ budgetMs: DEFAULT_BUDGET_MS, now });
}

export type WaitForWinnersSaveOptions = {
  /** **分け合う予算。** 既定は自分のぶんだけを持つ（誰とも分けない）。 */
  readonly budget?: TimeBudget;
  readonly delaysMs?: readonly number[];
  /** **差し替えるための引数であって、抽象ではない**（#64 と同じ形）。 */
  readonly sleep?: (ms: number) => Promise<void>;
};

export function createWaitForWinnersSave({
  budget = createWinnersSaveBudget(),
  delaysMs = DEFAULT_DELAYS_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: WaitForWinnersSaveOptions = {}): WaitForWinnersSave {
  return async (attempt: number) => {
    // **訊いた時点から数え始まる。** **その前の 1 回目の `load` は、待つと
    // 決める前に必ず起きる**ので、**「待ちのために止めた時間」には入れない。**
    const remaining = budget.askRemainingMs();
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
