/**
 * **待つ長さを決めているのはここだけ** (#214)。
 *
 * **試験は時計を回さない。** **`sleep` を差し替えて、何ミリ秒を何回頼んだかを見る**
 * ——**本物の待ちを入れると、試験が遅くなるだけで何も増えない**（#131 / #137）。
 */

import { describe, expect, it } from "vitest";
import { createWaitForWinnersSave } from "./wait-for-winners-save";

function sleeper() {
  const asked: number[] = [];
  return { asked, sleep: async (ms: number) => void asked.push(ms) };
}

describe("勝った側の保存を待つ間合い", () => {
  it("渡された順に待つ", async () => {
    const { asked, sleep } = sleeper();
    const wait = createWaitForWinnersSave({ delaysMs: [10, 20, 30], sleep });

    expect(await wait(1)).toBe(true);
    expect(await wait(2)).toBe(true);
    expect(asked).toEqual([10, 20]);
  });

  it("尽きたら打ち切る", async () => {
    // **倒す先は 2 つある**——**待ちすぎて画面が止まらない**
    const { asked, sleep } = sleeper();
    const wait = createWaitForWinnersSave({ delaysMs: [10], sleep });

    expect(await wait(1)).toBe(true);
    expect(await wait(2), "尽きているのに待たせている").toBe(false);
    expect(asked, "打ち切るときに待っている").toEqual([10]);
  });

  it("間合いが空なら、一度も待たない", async () => {
    const { asked, sleep } = sleeper();
    const wait = createWaitForWinnersSave({ delaysMs: [], sleep });

    expect(await wait(1)).toBe(false);
    expect(asked).toEqual([]);
  });

  it("待つ総和に上限がある", async () => {
    // **既定を変えるとき、ここが「どれだけ画面を止めてよいか」を見せる。**
    // **窓は `save` 1 回ぶん**（DB へ 1 往復）なので、**秒の単位では待たない**
    const { asked, sleep } = sleeper();
    const wait = createWaitForWinnersSave({ sleep });

    let attempt = 1;
    while (await wait(attempt)) {
      attempt += 1;
    }

    expect(asked.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(500);
    expect(asked.length, "一度も待たない既定になっている").toBeGreaterThan(0);
  });
});
