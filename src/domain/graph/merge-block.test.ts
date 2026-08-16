import { describe, expect, it } from "vitest";
import type { DependencyEdge, PullRequestRef } from "./dependency-graph";
import { buildDependencyEdges } from "./dependency-graph";
import type { DependencyOrder } from "./dependency-order";
import { orderByDependency } from "./dependency-order";
import { mergeBlockFor } from "./merge-block";

function pr(number: number, base: string, head: string): PullRequestRef {
  return {
    number,
    base: { repository: "r", branch: base },
    head: { repository: "r", branch: head },
  };
}

/** #9 が #8 の上に積まれている、いちばん小さなスタック。 */
const STACK = [pr(8, "main", "feat/a"), pr(9, "feat/a", "feat/b")];

function blockFor(pullRequests: readonly PullRequestRef[], number: number) {
  const edges = buildDependencyEdges(pullRequests);
  return mergeBlockFor(number, edges, orderByDependency(pullRequests, edges));
}

describe("依存が残っているかを決める", () => {
  it("土台の PR は、そのままマージできる", () => {
    expect(blockFor(STACK, 8)).toEqual({ kind: "ready" });
  });

  it("上に積まれた PR は、土台を先に入れるまでマージできない", () => {
    // **先にマージすると、土台のブランチへ上段の変更が入り、
    // 土台の PR を承認した人が見たものと中身が変わる**（#345）
    expect(blockFor(STACK, 9)).toEqual({ kind: "depends-on", numbers: [8] });
  });

  it("何を先に入れればよいかを返す", () => {
    // **「押せない」だけでは足りない**（#345 の完了条件）
    const block = blockFor(STACK, 9);

    expect(block.kind === "depends-on" && block.numbers).toEqual([8]);
  });

  it("土台が閉じていれば、依存は残っていない", () => {
    // **`buildDependencyEdges` は閉じた PR の head から辺を作らない**
    // ——**一覧に居ない = マージ済みか閉じている**ので、**待つ相手がいない**
    expect(blockFor([pr(9, "feat/a", "feat/b")], 9)).toEqual({ kind: "ready" });
  });

  it("循環している番号はマージできない", () => {
    // **順序が付かない**ので、**「何を先に」も言えない**——**押させない**
    const cycle = [pr(1, "feat/b", "feat/a"), pr(2, "feat/a", "feat/b")];

    expect(blockFor(cycle, 1)).toEqual({ kind: "not-orderable" });
    expect(blockFor(cycle, 2)).toEqual({ kind: "not-orderable" });
  });

  it("循環の上に積まれたものもマージできない", () => {
    // **`order.cyclic` には「その先に積まれたもの」も入る**（`DependencyOrder`）
    const cycle = [pr(1, "feat/b", "feat/a"), pr(2, "feat/a", "feat/b"), pr(3, "feat/b", "feat/c")];

    expect(blockFor(cycle, 3).kind).not.toBe("ready");
  });

  it("一覧に無い番号は、マージできるとは言わない", () => {
    // **知らないものを「安全」に倒さない**——**盤面と POST の間で
    // 一覧が変わることがある**（#345 は POST の口でも見る）
    expect(blockFor(STACK, 999).kind).not.toBe("ready");
  });
});

describe("順序と辺が食い違っていても、緩い側へ倒さない", () => {
  it("辺に無くても、循環に居ればマージできない", () => {
    const edges: readonly DependencyEdge[] = [];
    const order: DependencyOrder = { ordered: [], cyclic: [7] };

    expect(mergeBlockFor(7, edges, order)).toEqual({ kind: "not-orderable" });
  });
});
