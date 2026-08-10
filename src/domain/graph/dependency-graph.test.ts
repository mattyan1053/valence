import { describe, expect, it } from "vitest";
import { buildDependencyEdges, type PullRequestRef } from "./dependency-graph";

/** テストの見通しのために、必要な 3 つだけを渡す。 */
function pr(number: number, baseBranch: string, headBranch: string): PullRequestRef {
  return { number, baseBranch, headBranch };
}

describe("PR の依存グラフ", () => {
  it("直列に積まれた 4 本からは 3 本の辺ができる", () => {
    // このリポジトリで実際にあった形（#8 → #9 → #10 → #11）
    const edges = buildDependencyEdges([
      pr(8, "main", "feat/a"),
      pr(9, "feat/a", "feat/b"),
      pr(10, "feat/b", "feat/c"),
      pr(11, "feat/c", "feat/d"),
    ]);

    expect(edges).toEqual([
      { dependent: 9, dependsOn: 8 },
      { dependent: 10, dependsOn: 9 },
      { dependent: 11, dependsOn: 10 },
    ]);
  });

  it("base が既定ブランチだけなら辺は 0 本", () => {
    const edges = buildDependencyEdges([pr(1, "main", "feat/a"), pr(2, "main", "feat/b")]);

    expect(edges).toEqual([]);
  });

  it("base に対応する PR が無ければ辺を作らない", () => {
    // 閉じた PR の head を base にしたまま残っている場合。
    // **分からないものを辺にしない。** 推測で繋ぐと、存在しない依存が描かれる
    const edges = buildDependencyEdges([pr(12, "feat/closed", "feat/x")]);

    expect(edges).toEqual([]);
  });

  it("既定ブランチの名前に依存しない", () => {
    // **`main` を埋め込まない。** 既定ブランチ名はリポジトリごとに違う。
    // 「どの PR の head でもない」ことで自然に外れる
    const edges = buildDependencyEdges([
      pr(1, "trunk", "feat/a"),
      pr(2, "feat/a", "feat/b"),
      pr(3, "trunk", "feat/c"),
    ]);

    expect(edges).toEqual([{ dependent: 2, dependsOn: 1 }]);
  });

  it("同じ PR に 2 本積まれていれば、辺も 2 本になる", () => {
    const edges = buildDependencyEdges([
      pr(1, "main", "feat/a"),
      pr(2, "feat/a", "feat/b"),
      pr(3, "feat/a", "feat/c"),
    ]);

    expect(edges).toEqual([
      { dependent: 2, dependsOn: 1 },
      { dependent: 3, dependsOn: 1 },
    ]);
  });

  it("head が重複していたら、その base からは辺を作らない", () => {
    // 通常は起きないが、閉じた PR を含めると起こりうる。**どちらに積まれたのか
    // 決められない**ので、片方を選ばず辺を作らない（分からないものを辺にしない）
    const edges = buildDependencyEdges([
      pr(1, "main", "feat/a"),
      pr(2, "main", "feat/a"),
      pr(3, "feat/a", "feat/b"),
    ]);

    expect(edges).toEqual([]);
  });

  it("自分自身への辺は作らない", () => {
    // base と head が同じ PR は作れないが、変換の誤りで届きうる。
    // 通すと「自分を待つ PR」ができ、順序が決まらなくなる
    const edges = buildDependencyEdges([pr(1, "feat/a", "feat/a")]);

    expect(edges).toEqual([]);
  });

  it("PR が 0 件でも落ちない", () => {
    expect(buildDependencyEdges([])).toEqual([]);
  });

  it("入力の順序で辺を返す（同じ入力なら同じ出力）", () => {
    // 描画も順序判定もこの並びを前提にできるよう、決定論的にする
    const input = [pr(3, "feat/b", "feat/c"), pr(1, "main", "feat/a"), pr(2, "feat/a", "feat/b")];

    expect(buildDependencyEdges(input)).toEqual([
      { dependent: 3, dependsOn: 2 },
      { dependent: 2, dependsOn: 1 },
    ]);
  });
});
