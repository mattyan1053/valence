import { describe, expect, it } from "vitest";
import { buildDependencyEdges, type PullRequestRef } from "./dependency-graph";

/** 同じリポジトリに閉じた PR。ほとんどの例はこの形になる。 */
function pr(number: number, baseBranch: string, headBranch: string): PullRequestRef {
  return {
    number,
    base: { repository: "upstream", branch: baseBranch },
    head: { repository: "upstream", branch: headBranch },
  };
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

  it("番号が重複した入力は落とす", () => {
    // **番号が一意なのは「1 つのリポジトリの PR 一覧」だからである。**
    // 重複しているなら前提が破られている。通すと、自己辺の判定が別の PR を
    // 巻き込み、**静かに間違った辺が出る**
    expect(() =>
      buildDependencyEdges([pr(1, "main", "feat/a"), pr(1, "feat/a", "feat/b")]),
    ).toThrow(/#1/);
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

describe("fork をまたぐ PR", () => {
  it("同名でもリポジトリが違えば辺を作らない", () => {
    // **参照は (リポジトリ, ブランチ) の組である。** public リポジトリなので
    // fork からの PR は普通に来る。名前一致で繋ぐと、**upstream の feature を
    // base にする PR が、fork の同名ブランチに積まれているように見える**
    const edges = buildDependencyEdges([
      {
        number: 1,
        base: { repository: "upstream", branch: "main" },
        head: { repository: "fork", branch: "feature" },
      },
      {
        number: 2,
        base: { repository: "upstream", branch: "feature" },
        head: { repository: "upstream", branch: "feat/b" },
      },
    ]);

    expect(edges).toEqual([]);
  });

  it("fork の中で積まれていれば辺ができる", () => {
    // リポジトリが同じなら従来どおり。**名前だけを見ないことと、
    // fork を一律に切り捨てることは別**である
    const edges = buildDependencyEdges([
      {
        number: 1,
        base: { repository: "upstream", branch: "main" },
        head: { repository: "fork", branch: "feature" },
      },
      {
        number: 2,
        base: { repository: "fork", branch: "feature" },
        head: { repository: "fork", branch: "feat/b" },
      },
    ]);

    expect(edges).toEqual([{ dependent: 2, dependsOn: 1 }]);
  });

  // 識別子もブランチ名も境界から来る文字列なので、**連結して鍵にすると
  // 区切りを含む名前で別の組と衝突させられる**。実際に衝突する入力で固定する。
  it.each([
    // `${repository}:${branch}` で連結すると、どちらも "a:b:c" になる
    {
      delimiter: "コロン",
      left: { repository: "a", branch: "b:c" },
      right: { repository: "a:b", branch: "c" },
    },
    // 区切り無しで連結すると、どちらも "abc" になる
    {
      delimiter: "区切り無し",
      left: { repository: "a", branch: "bc" },
      right: { repository: "ab", branch: "c" },
    },
  ])("$delimiter で連結したときに衝突する組でも、別の参照として扱う", ({ left, right }) => {
    const edges = buildDependencyEdges([
      { number: 1, base: { repository: "upstream", branch: "main" }, head: left },
      { number: 2, base: right, head: { repository: "upstream", branch: "feat/b" } },
    ]);

    expect(edges).toEqual([]);
  });
});
