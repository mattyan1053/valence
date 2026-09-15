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
import { z } from "zod";
import { sampleBoard } from "./fixture";

const board = sampleBoard();

// **union のまま読まない。** **`sampleBoard()` は「署名していない」も返しうる型**なので、
// **絞らずに `plan` を触ると、盤面でなかったときに何も言わずに落ちる。**
if (board.kind !== "board") {
  throw new Error(`見本が盤面ではありません: ${board.kind}`);
}
const plan = board.plan;

/**
 * **判定へ渡す最小の形。** **図が描くのと同じもの**である。
 *
 * **`base`/`head` から組み直さない** (#741 のレビュー 2 周目)。**絵を描くのは
 * `plan.edges`**（`dependency-graph-view.tsx` が `layoutDependencyGraph` へ渡す）で、
 * **`buildDependencyEdges` は辺を落とす**——**同じ head を持つ PR が 2 本あると
 * `AMBIGUOUS` になり、その枝を base に持つ辺が消える。**
 *
 * **測った**（**`#114` の head を `#102` とぶつけた**）——**辺は 7 から 6 へ減り、
 * `103 <- 102` が消えたのに、`base`/`head` から数える版は 4 つとも緑**だった。
 * **行を 1 本足して head がぶつかっただけで、線が 1 本消える。**
 */
type Edges = readonly { readonly dependent: number; readonly dependsOn: number }[];

/** **他の PR に積まれている PR。** **`main` から生えているものは辺を持たない。** */
function stacked(edges: Edges): readonly number[] {
  return [...new Set(edges.map((one) => one.dependent))];
}

/**
 * **その PR の下にいくつ積まれているか。**
 *
 * **辺の本数で数える**（#740 が「いまの最大は 2」と数えたのと同じ）
 * ——**`#101 → #102 → #103` の 1 本鎖は 2** である。**PR の個数で数えると 1 多くなり、
 * 「3 以上」が最初から満たされてしまう**（**測った**）。
 *
 * **`main` へ辿り着いた鎖だけを数える** (#741 のレビュー)。**循環は `undefined`**
 * ——**前の版は、循環を見つけた段で `0` を返しながら、そこまでの各段が `1` を
 * 足していた**ので、**3 頂点の循環だけで 3 を返した。** **本物の鎖を落としても
 * 緑になる**（**下の「循環だけの図」で測っている**）。
 */
function depthBelow(
  edges: Edges,
  number: number,
  seen: ReadonlySet<number> = new Set(),
): number | undefined {
  if (seen.has(number)) {
    return undefined; // **辿り切れない**——**深さは決まらない**
  }
  const edge = edges.find((one) => one.dependent === number);
  if (edge === undefined) {
    return 0; // **`main` に着いた**
  }
  const below = depthBelow(edges, edge.dependsOn, new Set([...seen, number]));

  return below === undefined ? undefined : below + 1;
}

/** **図の中でいちばん深い鎖。** **辿り切れないものは数に入れない。** */
function deepest(edges: Edges): number {
  const depths = edges
    .map((one) => depthBelow(edges, one.dependent))
    .filter((one): one is number => one !== undefined);

  return Math.max(0, ...depths);
}

describe("見本の積み重ね", () => {
  it("積まれた PR が 4 本以上ある", () => {
    expect(stacked(plan.edges).length, "他の PR に積まれた PR が足りない").toBeGreaterThanOrEqual(
      4,
    );
  });

  it("枝分かれが 1 箇所以上ある", () => {
    // **同じ土台に 2 本**——**線が分かれて見えるのはここだけ**である。
    const perBase = new Map<number, number>();
    for (const one of plan.edges) {
      perBase.set(one.dependsOn, (perBase.get(one.dependsOn) ?? 0) + 1);
    }

    const forks = [...perBase.values()].filter((count) => count >= 2);

    expect(forks.length, "同じ土台から 2 本出ている箇所が無い").toBeGreaterThanOrEqual(1);
  });

  it("深さが 3 以上ある", () => {
    expect(deepest(plan.edges), "積み重ねが浅い（1 本鎖の長さが足りない）").toBeGreaterThanOrEqual(
      3,
    );
  });

  it("循環だけの図は、深さに数えない", () => {
    // **判定だけを取り出す**（`AGENTS.md` §4。#741 のレビュー）——**本物の材料では
    // 差が出ない**。**いまの見本の循環は 2 頂点**なので、**`#113` を消す変異は
    // 前の版でも赤くなった**——**広いことを、材料の側からは測れなかった。**
    //
    // **3 頂点の循環を、鎖ひとつ無い図で走らせる**と、**前の版は 3 を返した。**
    const onlyACycle: Edges = [
      { dependent: 1, dependsOn: 2 },
      { dependent: 2, dependsOn: 3 },
      { dependent: 3, dependsOn: 1 },
    ];

    expect(deepest(onlyACycle), "辿り切れない循環を、積み重ねとして数えている").toBe(0);
  });

  it("並べられなかったものが出ている", () => {
    // **`order.cyclic` は「依存が永久に解けない PR」**（`dependency-order.ts`）。
    // **本物の盤面には出る形**なので、**見本にも無いと、その節を人が見られない。**
    expect(plan.order.cyclic.length, "循環が 1 つも無い").toBeGreaterThan(0);
  });
});

/**
 * **行を足したときに、行から出していない値が置いていかれる** (#741 のレビュー)。
 *
 * **これは #740 が直しに来たものと同じ形**である——**`edges` が手で並べた 2 本の
 * literal だった**のと同じく、**日付は `12 - index` という、行数と関係のない数**から
 * 出ていた。**16 行に増えた結果、`2026-09-00` / `2026-09--1` / `2026-09--2` が出る。**
 *
 * **どれも `z.iso.datetime()` を通らない**ので、**「不明」が 3 行増える**
 * ——**「読めなかった」を 1 行だけ持たせる、という元の意図も壊れる。**
 */
describe("見本の日付", () => {
  it("どれも日時として読める", () => {
    const board = sampleBoard();
    if (board.kind !== "board") {
      throw new Error(`見本が盤面ではありません: ${board.kind}`);
    }
    // **境界と同じ規則で見る**（`pull-request-mapping.ts` が使うもの）
    // ——**自前の正規表現で見ると、通る形が食い違う。**
    const broken = [...board.plan.updatedAt].filter(
      ([, when]) => !z.iso.datetime().safeParse(when).success,
    );

    expect(broken, `日時として読めない値がある: ${JSON.stringify(broken)}`).toEqual([]);
  });

  it("読めなかった行は 1 行だけ", () => {
    // **本物より狭くしない**（#673）——**「読めなかった」は在ってよい**が、
    // **数が勝手に増えると、意図して置いた 1 行と区別できない。**
    const board = sampleBoard();
    if (board.kind !== "board") {
      throw new Error(`見本が盤面ではありません: ${board.kind}`);
    }
    const missing = board.plan.pullRequests.filter((one) => !board.plan.updatedAt.has(one.number));

    expect(
      missing.map((one) => one.number),
      "日時を持たない行が 1 行ではない",
    ).toEqual([112]);
  });
});
