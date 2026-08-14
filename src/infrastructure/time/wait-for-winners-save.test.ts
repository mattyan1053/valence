/**
 * **待つ長さを決めているのはここだけ** (#214)。
 *
 * **試験は時計を回さない。** **`sleep` を差し替えて、何ミリ秒を何回頼んだかを見る**
 * ——**本物の待ちを入れると、試験が遅くなるだけで何も増えない**（#131 / #137）。
 */

import { describe, expect, it } from "vitest";
import { createTimeBudget } from "./time-budget";
import { createWaitForWinnersSave, createWinnersSaveBudget } from "./wait-for-winners-save";

/**
 * 差し替える `sleep` と時計。**頼んだぶんだけ時が進む**——
 * **本物の時計を回さずに、実時間の締切を確かめられる**（#131 / #137）。
 */
function sleeper(extraPerCallMs = 0) {
  const asked: number[] = [];
  let elapsed = 0;
  return {
    asked,
    now: () => {
      // **呼ばれるたびに、読み直し 1 回ぶんの時間が過ぎている**
      elapsed += extraPerCallMs;
      return elapsed;
    },
    sleep: async (ms: number) => {
      asked.push(ms);
      elapsed += ms;
    },
  };
}

describe("勝った側の保存を待つ間合い", () => {
  it("渡された順に待つ", async () => {
    const { asked, sleep, now } = sleeper();
    const wait = createWaitForWinnersSave({
      budget: createWinnersSaveBudget(now),
      delaysMs: [10, 20, 30],
      sleep,
    });

    expect(await wait(1)).toBe(true);
    expect(await wait(2)).toBe(true);
    expect(asked).toEqual([10, 20]);
  });

  it("尽きたら打ち切る", async () => {
    // **倒す先は 2 つある**——**待ちすぎて画面が止まらない**
    const { asked, sleep, now } = sleeper();
    const wait = createWaitForWinnersSave({
      budget: createWinnersSaveBudget(now),
      delaysMs: [10],
      sleep,
    });

    expect(await wait(1)).toBe(true);
    expect(await wait(2), "尽きているのに待たせている").toBe(false);
    expect(asked, "打ち切るときに待っている").toEqual([10]);
  });

  it("間合いが空なら、一度も待たない", async () => {
    const { asked, sleep, now } = sleeper();
    const wait = createWaitForWinnersSave({
      budget: createWinnersSaveBudget(now),
      delaysMs: [],
      sleep,
    });

    expect(await wait(1)).toBe(false);
    expect(asked).toEqual([]);
  });

  it("既定の間合いは、既定の予算に収まる", async () => {
    // **既定を変えるとき、ここが「どれだけ待ってよいか」を見せる。**
    // **窓は `save` 1 回ぶん**（DB へ 1 往復）なので、**秒の単位では待たない**
    const { asked, sleep, now } = sleeper();
    const wait = createWaitForWinnersSave({ budget: createWinnersSaveBudget(now), sleep });

    let attempt = 1;
    while (await wait(attempt)) {
      attempt += 1;
    }

    expect(asked.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(500);
    expect(asked.length, "一度も待たない既定になっている").toBeGreaterThan(0);
  });
});

describe("止まる時間そのものに上限がある", () => {
  // **#254 のレビュー。** **数えていたのが `sleep` だけ**で、
  // **読み直し（`store.load()`）の往復が入っていなかった**——
  // **ループは `load → 待つ → load → …`** なので、**実際に止まるのは
  // 「待ちの合計 + 往復の合計」**である。**遅い置き場では、上限が上限にならない。**

  it("読み直しが遅ければ、待てる回数が減る", async () => {
    // **1 回の往復に 200ms かかる置き場。** **予算 500ms は往復にも食われる**
    const { asked, sleep, now } = sleeper(200);
    const wait = createWaitForWinnersSave({
      budget: createTimeBudget({ budgetMs: 500, now }),
      delaysMs: [50, 150, 300],
      sleep,
    });

    const answers = [await wait(1), await wait(2), await wait(3)];

    expect(answers, "遅い置き場でも回数どおり待っている").toEqual([true, true, false]);
    expect(asked.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(500);
  });

  it("最後の待ちは、予算からはみ出さない", async () => {
    // **残りが 100ms しか無いのに 300ms 待たない**
    const { asked, sleep, now } = sleeper(0);
    const wait = createWaitForWinnersSave({
      budget: createTimeBudget({ budgetMs: 100, now }),
      delaysMs: [50, 300],
      sleep,
    });

    expect(await wait(1)).toBe(true);
    expect(await wait(2)).toBe(true);
    expect(asked).toEqual([50, 50]);
  });

  it("予算を使い切ったら、間合いが残っていても打ち切る", async () => {
    const { asked, sleep, now } = sleeper(1000);
    const wait = createWaitForWinnersSave({
      budget: createTimeBudget({ budgetMs: 500, now }),
      delaysMs: [50, 150, 300],
      sleep,
    });

    expect(await wait(1), "1 回目は待てる").toBe(true);
    expect(await wait(2), "予算を超えているのに待っている").toBe(false);
    expect(asked, "打ち切るときに待っている").toEqual([50]);
  });
});
