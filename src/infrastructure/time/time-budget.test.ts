/**
 * **「あとどれだけ待てるか」を持つのはここだけ** (#255)。
 *
 * **試験は時計を回さない。** **`now` を差し替えて、読んだ回数と値で見る**（#131 / #137）。
 */

import { describe, expect, it } from "vitest";
import { createTimeBudget } from "./time-budget";

/** 差し替える時計。**進めるのは試験の側**——**本物の時間は使わない。** */
function clock(start = 0) {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

describe("実時間の予算", () => {
  it("最初に訊いた時刻から数える", () => {
    const { now, advance } = clock();
    const budget = createTimeBudget({ budgetMs: 500, now });

    advance(1000); // **訊く前に過ぎた時間は、予算を食わない**
    expect(budget.askRemainingMs()).toBe(500);
    advance(200);
    expect(budget.askRemainingMs()).toBe(300);
  });

  it("使い切ったら 0 以下になる", () => {
    const { now, advance } = clock();
    const budget = createTimeBudget({ budgetMs: 100, now });

    expect(budget.askRemainingMs()).toBe(100);
    advance(150);
    expect(budget.askRemainingMs(), "尽きているのに残っている").toBeLessThanOrEqual(0);
  });

  it("訊かれるまでは、覗いても何も出さない", () => {
    // **待つ前の 1 回目の読みは、この予算の外にある**——
    // **そこで全額を渡すと、普通の読み出しまで待ちの予算で切られる**
    const { now } = clock();
    const budget = createTimeBudget({ budgetMs: 500, now });

    expect(budget.peekRemainingMs()).toBeUndefined();
  });

  it("覗いても、数え始めない", () => {
    // **覗いた側が時計を始めると、待つ側の予算が「覗いた時刻」から数えられる**
    const { now, advance } = clock();
    const budget = createTimeBudget({ budgetMs: 500, now });

    budget.peekRemainingMs();
    advance(300);
    expect(budget.askRemainingMs(), "覗いたところから数えている").toBe(500);
  });

  it("数え始めたあとは、残りを覗ける", () => {
    const { now, advance } = clock();
    const budget = createTimeBudget({ budgetMs: 500, now });

    budget.askRemainingMs();
    advance(200);
    expect(budget.peekRemainingMs()).toBe(300);
  });
});
