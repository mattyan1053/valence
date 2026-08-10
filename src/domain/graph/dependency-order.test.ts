import { describe, expect, it } from "vitest";
import type { PullRequestRef } from "./dependency-graph";
import { orderByDependency } from "./dependency-order";

/** 順序は辺だけで決まるので、参照は結果に効かない。番号を読みやすくするための道具。 */
function pr(number: number): PullRequestRef {
  return {
    number,
    base: { repository: "upstream", branch: "main" },
    head: { repository: "upstream", branch: `feat/${number}` },
  };
}

describe("依存の順序", () => {
  it("直列に積まれていれば土台が先に並ぶ", () => {
    // このリポジトリで実際にあった形（#8 → #9 → #10 → #11）
    const result = orderByDependency(
      [pr(8), pr(9), pr(10), pr(11)],
      [
        { dependent: 9, dependsOn: 8 },
        { dependent: 10, dependsOn: 9 },
        { dependent: 11, dependsOn: 10 },
      ],
    );

    expect(result).toEqual({ ordered: [8, 9, 10, 11], cyclic: [] });
  });

  it("入力が依存の逆順でも土台が先に並ぶ", () => {
    // **入力の並びは順序を決めない。** ここが逆転すると、積んだ側を先に
    // 出してしまい「土台を先に出す」という目的そのものが崩れる
    const result = orderByDependency(
      [pr(11), pr(10), pr(9), pr(8)],
      [
        { dependent: 9, dependsOn: 8 },
        { dependent: 10, dependsOn: 9 },
        { dependent: 11, dependsOn: 10 },
      ],
    );

    expect(result).toEqual({ ordered: [8, 9, 10, 11], cyclic: [] });
  });

  it("枝分かれしていても、土台がどちらより先に並ぶ", () => {
    const result = orderByDependency(
      [pr(1), pr(2), pr(3)],
      [
        { dependent: 2, dependsOn: 1 },
        { dependent: 3, dependsOn: 1 },
      ],
    );

    expect(result).toEqual({ ordered: [1, 2, 3], cyclic: [] });
  });

  it("辺を持たない PR も順序に入る", () => {
    // 依存の無い PR はそのまま出せる。落とすと**レビューする一覧から消える**
    const result = orderByDependency([pr(1), pr(2)], []);

    expect(result).toEqual({ ordered: [1, 2], cyclic: [] });
  });

  it("同じ深さの並びは入力の順に従う", () => {
    // **決めないと実行のたびに変わる。** 番号順のような別の基準を持ち込むと、
    // 呼び出し側が決めた並び（GitHub の一覧順など）と競合する
    const edges = [
      { dependent: 2, dependsOn: 1 },
      { dependent: 3, dependsOn: 1 },
    ];

    expect(orderByDependency([pr(1), pr(3), pr(2)], edges).ordered).toEqual([1, 3, 2]);
    expect(orderByDependency([pr(1), pr(2), pr(3)], edges).ordered).toEqual([1, 2, 3]);
  });

  it("鎖が 2 本あっても、同じ深さは入力の順に並ぶ", () => {
    // **根が 1 つだと、この食い違いを通してしまう。** 走査の途中で依存を外すと、
    // **同じ走査の中で解放された深いもの**（#4）が、まだ見ていない浅いもの（#1）
    // より先に出る。依存は守られているので、静かにずれる
    const result = orderByDependency(
      [pr(2), pr(3), pr(4), pr(1)],
      [
        { dependent: 2, dependsOn: 1 },
        { dependent: 4, dependsOn: 3 },
      ],
    );

    expect(result.ordered).toEqual([3, 1, 2, 4]);
  });

  it("循環に含まれる PR は順序に混ざらず、別に返る", () => {
    // **循環を「無い」に丸めない。** 混ぜると、依存を無視した順序が正しい顔で出る
    const result = orderByDependency(
      [pr(1), pr(2), pr(3)],
      [
        { dependent: 1, dependsOn: 2 },
        { dependent: 2, dependsOn: 1 },
      ],
    );

    expect(result).toEqual({ ordered: [3], cyclic: [1, 2] });
  });

  it("循環の先に積まれた PR も並べられない", () => {
    // 循環そのものには入っていないが、**順序が決まらない**ことに変わりはない。
    // 出すと、まだマージできない PR を先に見せることになる
    const result = orderByDependency(
      [pr(1), pr(2), pr(3)],
      [
        { dependent: 1, dependsOn: 2 },
        { dependent: 2, dependsOn: 1 },
        { dependent: 3, dependsOn: 1 },
      ],
    );

    expect(result).toEqual({ ordered: [], cyclic: [1, 2, 3] });
  });

  it("PR が 0 件でも落ちない", () => {
    expect(orderByDependency([], [])).toEqual({ ordered: [], cyclic: [] });
  });

  it("入力に無い PR を指す辺は落とす", () => {
    // 辺と一覧は同じ入力から作られる前提。食い違っているなら
    // **呼び出し側が別々のものを渡している**ので、黙って無視しない
    expect(() => orderByDependency([pr(1)], [{ dependent: 1, dependsOn: 2 }])).toThrow(/#2/);
    expect(() => orderByDependency([pr(1)], [{ dependent: 2, dependsOn: 1 }])).toThrow(/#2/);
  });

  it("番号が重複した入力は落とす", () => {
    // buildDependencyEdges と同じ前提（1 つのリポジトリの PR 一覧）に立つので、
    // ここでも確かめる。通すと同じ番号が順序に 2 回出る
    expect(() => orderByDependency([pr(1), pr(1)], [])).toThrow(/#1/);
  });
});
