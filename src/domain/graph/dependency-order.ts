/**
 * 依存グラフから、レビューする順序を決める。
 *
 * **辺があるだけでは「どれから見るか」は決まらない。** 土台の PR を先に出すのが
 * レビュアーの交通整理の最初の効き所で、順序は辺から機械的に決まる。
 */

import type { DependencyEdge, PullRequestRef } from "./dependency-graph";

/**
 * 依存の順に並べた結果。
 *
 * **順序と循環を混ぜない。** 並べられなかったものを順序の中に紛れ込ませると、
 * 依存を無視した並びが正しい顔で出てくる。
 */
export type DependencyOrder = {
  /** 土台が先に来る並び。ここに出た順にマージできる。 */
  readonly ordered: readonly number[];
  /** 並べられなかった PR。循環に含まれるものと、その先に積まれたもの。 */
  readonly cyclic: readonly number[];
};

/**
 * PR を依存の順に並べる。
 *
 * `edges` は同じ `pullRequests` から `buildDependencyEdges` で作ったものを渡す。
 * **食い違っていたら落とす。** 別々のものを渡されたまま進むと、順序は出るのに
 * 依存が抜けている、という気づけない壊れ方をする。
 *
 * **同じ深さのものは入力の順に並べる。** 決めないと実行のたびに変わり、テストも
 * UI も揺れる。番号順のような別の基準を持ち込まないのは、**呼び出し側が決めた
 * 並び**（GitHub の一覧順など）と競合するからで、`buildDependencyEdges` が
 * 入力の順で辺を返すのと同じ考え方である。
 */
export function orderByDependency(
  pullRequests: readonly PullRequestRef[],
  edges: readonly DependencyEdge[],
): DependencyOrder {
  const blockedBy = indexByNumber(pullRequests);
  registerDependencies(blockedBy, edges);
  const ordered = drainReady(blockedBy, pullRequests);

  // 残っているのは、依存が永久に解けない PR ——循環に含まれるものと、その先に
  // 積まれたものである。後者は循環そのものには入っていないが、**順序が決まらない**
  // ことに変わりはないので、順序側へは出さない。
  const cyclic = pullRequests
    .map((pullRequest) => pullRequest.number)
    .filter((number) => blockedBy.has(number));
  return { ordered, cyclic };
}

/**
 * 辺を「まだ出ていない依存先」として登録する。
 *
 * **一覧に無い番号を指す辺は落とす。** 辺と一覧は同じ入力から作られる前提なので、
 * 食い違っているなら呼び出し側が別々のものを渡している。無視して進むと、
 * 順序は出るのに依存が抜けている、という気づけない壊れ方をする。
 */
function registerDependencies(
  blockedBy: Map<number, Set<number>>,
  edges: readonly DependencyEdge[],
): void {
  for (const edge of edges) {
    const dependencies = blockedBy.get(edge.dependent) ?? unknownNumber(edge.dependent);
    if (!blockedBy.has(edge.dependsOn)) {
      unknownNumber(edge.dependsOn);
    }
    dependencies.add(edge.dependsOn);
  }
}

/**
 * 依存が解けたものを、出せるものが無くなるまで取り出す。
 *
 * 取り出した PR は `blockedBy` から消える（**残ったものが並べられなかった PR**）。
 * 毎回 `pullRequests` の順に見るので、同じ深さのものは入力の順に並ぶ。
 */
function drainReady(
  blockedBy: Map<number, Set<number>>,
  pullRequests: readonly PullRequestRef[],
): number[] {
  const ordered: number[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const pullRequest of pullRequests) {
      const dependencies = blockedBy.get(pullRequest.number);
      if (dependencies === undefined || dependencies.size > 0) {
        continue;
      }
      blockedBy.delete(pullRequest.number);
      ordered.push(pullRequest.number);
      for (const rest of blockedBy.values()) {
        rest.delete(pullRequest.number);
      }
      progressed = true;
    }
  }
  return ordered;
}

/**
 * 番号ごとに「まだ出ていない依存先」の置き場を作る。
 *
 * **番号が一意なのは「1 つのリポジトリの PR 一覧」だからである**（`PullRequestRef`
 * を参照）。`buildDependencyEdges` と同じ前提に立つので、ここでも確かめる。
 * 通すと同じ番号が順序に 2 回出る。
 */
function indexByNumber(pullRequests: readonly PullRequestRef[]): Map<number, Set<number>> {
  const blockedBy = new Map<number, Set<number>>();
  for (const pullRequest of pullRequests) {
    if (blockedBy.has(pullRequest.number)) {
      throw new Error(`PR 番号が重複しています: #${pullRequest.number}`);
    }
    blockedBy.set(pullRequest.number, new Set());
  }
  return blockedBy;
}

function unknownNumber(number: number): never {
  throw new Error(`辺が指す PR が一覧にありません: #${number}`);
}
