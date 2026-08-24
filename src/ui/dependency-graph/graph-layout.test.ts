/**
 * **依存を目で追える形に置く**（#471）。
 *
 * **箇条書きでは、深さも枝分かれも見えない**——**`← #456 の上` が並ぶだけ**で、
 * **30 本になったとき、どれがどれの上にあるかを読み取れない**（**このプロダクトが
 * 狙うのは「PR に溺れている」状況**である）。
 *
 * **座標を決めるところだけを、ここで見る。** **描くのは別の部品**で、
 * **置き場所が正しいかは、絵を見なくても確かめられる。**
 */

import { describe, expect, it } from "vitest";
import type { DependencyEdge } from "../../domain/graph/dependency-graph";
import { layoutDependencyGraph } from "./graph-layout";

function positionOf(layout: ReturnType<typeof layoutDependencyGraph>, number: number) {
  const node = layout.nodes.find((candidate) => candidate.number === number);
  expect(node, `#${number} が図に出ていない`).toBeDefined();
  return node as NonNullable<typeof node>;
}

describe("依存グラフの置き場所", () => {
  it("土台が左、その上に積まれたものが右へ行く", () => {
    // **深さ＝いくつ積まれているか**である。**縦に並べると、枝分かれが潰れる**
    const layout = layoutDependencyGraph({
      placed: [1, 2, 3],
      edges: [
        { dependent: 2, dependsOn: 1 },
        { dependent: 3, dependsOn: 2 },
      ],
    });

    expect(positionOf(layout, 1).depth).toBe(0);
    expect(positionOf(layout, 2).depth).toBe(1);
    expect(positionOf(layout, 3).depth).toBe(2);
    expect(positionOf(layout, 1).x).toBeLessThan(positionOf(layout, 2).x);
  });

  it("いちばん深い依存から決まる", () => {
    // **合流する形**（#4 が #2 と #3 の上）——**浅いほうで決めると、辺が右から左へ戻る**
    const layout = layoutDependencyGraph({
      placed: [1, 2, 3, 4],
      edges: [
        { dependent: 2, dependsOn: 1 },
        { dependent: 3, dependsOn: 1 },
        { dependent: 4, dependsOn: 2 },
        { dependent: 4, dependsOn: 3 },
        { dependent: 3, dependsOn: 2 },
      ],
    });

    expect(positionOf(layout, 3).depth, "浅いほうで決めている").toBe(2);
    expect(positionOf(layout, 4).depth).toBe(3);
  });

  it("同じ深さのものは、重ならない", () => {
    const layout = layoutDependencyGraph({
      placed: [1, 2, 3],
      edges: [
        { dependent: 2, dependsOn: 1 },
        { dependent: 3, dependsOn: 1 },
      ],
    });

    expect(positionOf(layout, 2).depth).toBe(positionOf(layout, 3).depth);
    expect(positionOf(layout, 2).y).not.toBe(positionOf(layout, 3).y);
  });

  it("図に出ない相手への辺は、引かない", () => {
    // **並べられなかった PR（循環）や、読めなかった PR は `placed` に居ない**
    // ——**居ない相手へ線を引くと、どこへも繋がらない線が出る。**
    const layout = layoutDependencyGraph({
      placed: [2],
      edges: [{ dependent: 2, dependsOn: 99 }],
    });

    expect(layout.links, "居ない相手へ線を引いている").toEqual([]);
    expect(positionOf(layout, 2).depth, "居ない相手を深さに数えている").toBe(0);
  });

  it("辺は、土台の右から、積んだものの左へ引く", () => {
    const layout = layoutDependencyGraph({
      placed: [1, 2],
      edges: [{ dependent: 2, dependsOn: 1 }],
    });

    const link = layout.links[0];
    expect(link, "辺が 1 本も出ていない").toBeDefined();
    expect(link?.fromX, "土台の右端から出ていない").toBeGreaterThan(positionOf(layout, 1).x);
    expect(link?.toX, "積んだものの左端へ入っていない").toBe(positionOf(layout, 2).x);
  });

  it("大きさは、置いたものが収まる分だけ取る", () => {
    const layout = layoutDependencyGraph({
      placed: [1, 2],
      edges: [{ dependent: 2, dependsOn: 1 }],
    });

    for (const node of layout.nodes) {
      expect(node.x + layout.nodeWidth, "はみ出している").toBeLessThanOrEqual(layout.width);
      expect(node.y + layout.nodeHeight, "はみ出している").toBeLessThanOrEqual(layout.height);
    }
  });

  it("本数が増えても、置くだけで返る", () => {
    // **30 本で読めなければ意味がない**（#471）——**#120 / #158 で一度踏んでいる**ので、
    // **数が増えたときに掛け算にならないことを、ここで押さえる。**
    const placed = Array.from({ length: 300 }, (_, index) => index + 1);
    const edges: DependencyEdge[] = placed
      .slice(1)
      .map((number) => ({ dependent: number, dependsOn: number - 1 }));

    const started = process.hrtime.bigint();
    const layout = layoutDependencyGraph({ placed, edges });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(layout.nodes).toHaveLength(300);
    expect(elapsedMs, `置くのに ${elapsedMs}ms かかっている`).toBeLessThan(200);
  });
});
