/**
 * **見本が、線を訊ける形になっていること**（#740）。
 *
 * **#583 の完了条件「線が読める」が 7 回持ち越された。** **利用者が答えないからではなく、
 * 訊ける絵を見せていなかったから**である——**箱 12 個に対して辺は 2 本**で、
 * **`#101 → #102 → #103` の 1 本鎖だけ**だった。**線が 2 本なら読める。**
 * **何を答えても「読めた」になる。**
 *
 * ## `<line>` を数えない
 *
 * **描き方が変われば数が変わる**（#740 の完了条件）——**数えるのは材料の側**である。
 * **ここが読むのは `sampleBoard()` が返す plan**で、**図はそれを描く。**
 *
 * **「4 本以上」は独立した要求ではない**（#740 のコメント）——**枝分かれ 1・深さ 3・
 * 循環 1 を作ると、辺は自然にそれ以上になる。** **それでも数えるのは、
 * 下 3 つを満たしたまま辺が減る形を、あとから作らないため**である。
 *
 * ## 満たしたのに絵が変わらなかったら
 *
 * **fixture を触らない**（#740 のコメント）。**辺を落としているのが描く側**なので、
 * **別の Issue に落とす。** **数えられるほうを動かして緑にすると、
 * 「訊ける絵になった」と言いながら絵は同じ**になる——**#583 で 1 回起きたのがそれ**である。
 */

import { describe, expect, it } from "vitest";
import { sampleBoard } from "./fixture";

const board = sampleBoard();

// **union のまま読まない。** **`sampleBoard()` は「署名していない」も返しうる型**なので、
// **絞らずに `plan` を触ると、盤面でなかったときに何も言わずに落ちる。**
if (board.kind !== "board") {
  throw new Error(`見本が盤面ではありません: ${board.kind}`);
}
const plan = board.plan;

/** **他の PR の head に積まれている PR。** **`main` から生えているものは入らない。** */
function stacked(): readonly { number: number; base: string }[] {
  const heads = new Set(plan.pullRequests.map((one) => one.head.branch));

  return plan.pullRequests
    .filter((one) => heads.has(one.base.branch))
    .map((one) => ({ number: one.number, base: one.base.branch }));
}

/**
 * **その PR の下にいくつ積まれているか。**
 *
 * **辺の本数で数える**（#740 が「いまの最大は 2」と数えたのと同じ）
 * ——**`#101 → #102 → #103` の 1 本鎖は 2** である。**PR の個数で数えると 1 多くなり、
 * 「3 以上」が最初から満たされてしまう**（**測った**）。
 */
function depthBelow(branch: string, seen: ReadonlySet<string> = new Set()): number {
  if (seen.has(branch)) {
    return 0; // **循環は深さに数えない**（**辿り切れない**）
  }
  const parent = plan.pullRequests.find((one) => one.head.branch === branch);

  return parent === undefined ? 0 : 1 + depthBelow(parent.base.branch, new Set([...seen, branch]));
}

describe("見本の積み重ね", () => {
  it("積まれた PR が 4 本以上ある", () => {
    expect(stacked().length, "他の PR に積まれた PR が足りない").toBeGreaterThanOrEqual(4);
  });

  it("枝分かれが 1 箇所以上ある", () => {
    // **同じ土台に 2 本**——**線が分かれて見えるのはここだけ**である。
    const perBase = new Map<string, number>();
    for (const one of stacked()) {
      perBase.set(one.base, (perBase.get(one.base) ?? 0) + 1);
    }

    const forks = [...perBase.values()].filter((count) => count >= 2);

    expect(forks.length, "同じ土台から 2 本出ている箇所が無い").toBeGreaterThanOrEqual(1);
  });

  it("深さが 3 以上ある", () => {
    const deepest = Math.max(...plan.pullRequests.map((one) => depthBelow(one.base.branch)));

    expect(deepest, "積み重ねが浅い（1 本鎖の長さが足りない）").toBeGreaterThanOrEqual(3);
  });

  it("並べられなかったものが出ている", () => {
    // **`order.cyclic` は「依存が永久に解けない PR」**（`dependency-order.ts`）。
    // **本物の盤面には出る形**なので、**見本にも無いと、その節を人が見られない。**
    expect(plan.order.cyclic.length, "循環が 1 つも無い").toBeGreaterThan(0);
  });
});
