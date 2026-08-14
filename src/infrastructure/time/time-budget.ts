/**
 * **「あとどれだけ待てるか」を持つ実時間の予算** (#255)。
 *
 * **待つ側と、往復する側で分け合う。** **待ちの上限は、待ちだけでは守れない**——
 * **止まっている時間は「間合い + その間に挟まる往復」**なので、
 * **往復のほうも同じ残りを見なければ、上限が上限にならない**（#254 のレビュー）。
 *
 * **時計を差し替えられる**（#131 / #137）——**試験は本物の時間を回さない。**
 */

export type TimeBudget = {
  /**
   * **待つと決めた側が訊く。** 残り (ms)。**尽きていれば 0 以下。**
   *
   * **最初に訊かれた時刻から数え始める。** **作った時刻からではない**——
   * **要求の頭で作って、待つのはずっとあと**ということが普通に起きる。
   */
  askRemainingMs(): number;
  /**
   * **分け合う側が覗く。** **まだ訊かれていなければ `undefined`。**
   *
   * **覗くだけでは数え始めない。** **始めてしまうと、待つ側の予算が
   * 「覗かれた時刻」から数えられる**——**覗く回数で上限が変わる。**
   */
  peekRemainingMs(): number | undefined;
};

export type TimeBudgetOptions = {
  readonly budgetMs: number;
  /** いまを測る口。**`sleep` と同じ扱いにする** (#131 / #137)。 */
  readonly now?: () => number;
};

export function createTimeBudget({
  budgetMs,
  now = () => Date.now(),
}: TimeBudgetOptions): TimeBudget {
  let startedAt: number | undefined;

  return {
    askRemainingMs: () => {
      // **時計は 1 回だけ読む。** **2 回読むと、その間に進んだぶんが混ざる。**
      const askedAt = now();
      startedAt ??= askedAt;
      return budgetMs - (askedAt - startedAt);
    },
    peekRemainingMs: () => (startedAt === undefined ? undefined : budgetMs - (now() - startedAt)),
  };
}
