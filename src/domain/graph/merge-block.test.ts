import { describe, expect, it } from "vitest";
import type { DependencyEdge, PullRequestRef } from "./dependency-graph";
import { buildDependencyEdges } from "./dependency-graph";
import type { DependencyOrder } from "./dependency-order";
import { orderByDependency } from "./dependency-order";
import { mergeBlockFor, mergeBlocksFor } from "./merge-block";

function pr(number: number, base: string, head: string): PullRequestRef {
  return {
    number,
    base: { repository: "r", branch: base },
    head: { repository: "r", branch: head },
  };
}

/** #9 が #8 の上に積まれている、いちばん小さなスタック。 */
const STACK = [pr(8, "main", "feat/a"), pr(9, "feat/a", "feat/b")];

function blockFor(pullRequests: readonly PullRequestRef[], number: number, unreadable = 0) {
  const edges = buildDependencyEdges(pullRequests);
  return mergeBlockFor(number, edges, orderByDependency(pullRequests, edges), unreadable);
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

    expect(mergeBlockFor(7, edges, order, 0)).toEqual({ kind: "not-orderable" });
  });
});

describe("読めなかった PR があれば、順序を判定できたと言わない", () => {
  // **`PullRequestSource` は、検証に落ちた PR を `invalid` に残して正常終了する**
  // （#348 のレビュー）——**土台だけが読めなかった場合、辺が作られず、
  // 上段が `ready` に見える。** **投げないので `catch` にも入らない。**
  //
  // **図に抜けがあるなら、どの行の「依存なし」も信じられない。**
  it("依存が無く見えても、読めなかった PR があればマージさせない", () => {
    // **`pullRequests` の側は正常なまま**にしてある——**どちらが効いて赤くなったかを
    // 分けるため**（master の指示）
    expect(blockFor([pr(8, "main", "feat/a")], 8, 0)).toEqual({ kind: "ready" });

    expect(blockFor([pr(8, "main", "feat/a")], 8, 1)).toEqual({ kind: "not-orderable" });
  });

  it("土台が残っているときも、読めなかった側を優先して伝えない", () => {
    // **どちらも「押させない」**である——**先に入れる番号を名指しできるなら、
    // そちらのほうが役に立つ**
    expect(blockFor(STACK, 9, 1).kind).toBe("not-orderable");
  });
});

/**
 * **一覧ぶんをまとめて判定する**（#541 のレビュー）。
 *
 * **1 件ずつ呼ぶと、辺と順序を毎回なめ直す**——**盤面は全部の行について呼ぶ**ので、
 * **本数の 2 乗**になる。**判定は変えず、索引を 1 度だけ作る。**
 */
describe("一覧ぶんをまとめて判定する", () => {
  function blocksFor(pullRequests: readonly PullRequestRef[], unreadable = 0) {
    const edges = buildDependencyEdges(pullRequests);
    return mergeBlocksFor(
      pullRequests.map((pullRequest) => pullRequest.number),
      edges,
      orderByDependency(pullRequests, edges),
      unreadable,
    );
  }

  it("1 件ずつ訊いたのと、同じ答えを返す", () => {
    // **速さのために規則を書き写さない**——**答えが割れたら、画面の中で食い違う**
    const pullRequests = [
      ...STACK,
      pr(10, "feat/b", "feat/c"),
      pr(11, "main", "feat/x"),
      pr(12, "feat/y", "feat/z"),
    ];
    const blocks = blocksFor(pullRequests);

    for (const pullRequest of pullRequests) {
      expect(blocks.get(pullRequest.number), `#${pullRequest.number} の答えが割れている`).toEqual(
        blockFor(pullRequests, pullRequest.number),
      );
    }
  });

  it("読めなかった PR があるときも、1 件ずつ訊いたのと同じ答えを返す", () => {
    expect(blocksFor(STACK, 1).get(8)).toEqual(blockFor(STACK, 8, 1));
  });

  it("訊いていない番号は返らない", () => {
    const edges = buildDependencyEdges(STACK);

    expect([...mergeBlocksFor([8], edges, orderByDependency(STACK, edges), 0).keys()]).toEqual([8]);
  });

  it("本数が増えても、2 乗にならない", () => {
    // **1 件ずつ呼ぶ形では、10000 件で辺と順序を 10000 回なめ直す**——**秒の単位になる。**
    // **描画を挟まず、判定だけを測る**（#541 のレビュー）——**React を通すと、
    // 線形なぶんに埋もれて、2 乗の側が見えない。**
    // **辺と順序は手で置く。** **`buildDependencyEdges` / `orderByDependency` の速さは
    // ここの関心ではない**——**それぞれ 1 度しか呼ばれない**のに対し、
    // **この判定は行の数だけ呼ばれる。**
    const size = 10000;
    const numbers = Array.from({ length: size }, (_, index) => index + 1);
    const edges: DependencyEdge[] = numbers
      .slice(1)
      .map((number) => ({ dependent: number, dependsOn: number - 1 }));
    const order: DependencyOrder = { ordered: numbers, cyclic: [] };

    const started = process.hrtime.bigint();
    const blocks = mergeBlocksFor(numbers, edges, order, 0);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(blocks.size).toBe(size);
    expect(elapsedMs, `判定に ${elapsedMs}ms かかっている`).toBeLessThan(500);
  });
});

describe("何を先に入れるかの並び", () => {
  it("辺の並びのまま返す", () => {
    // **画面にそのまま出る**（`待ち: #8 ほか1 件` / Merge ボタンの脇）——**呼ぶたびに
    // 変わると、読み手には理由の分からない揺れになる。**
    //
    // **辺は手で置く。** **`buildDependencyEdges` は 1 つの PR に 1 本しか辺を作らない**
    // （**base に一致する head は 1 つ**）ので、**並びが問われる形はそこからは出てこない。**
    const edges: DependencyEdge[] = [
      { dependent: 9, dependsOn: 8 },
      { dependent: 9, dependsOn: 7 },
    ];
    const order: DependencyOrder = { ordered: [7, 8, 9], cyclic: [] };
    const expected = { kind: "depends-on", numbers: [8, 7] };

    expect(mergeBlocksFor([9], edges, order, 0).get(9)).toEqual(expected);
    // **1 件ずつ訊いても同じ並び**である（**索引を作ったことで変わっていない**）
    expect(mergeBlockFor(9, edges, order, 0)).toEqual(expected);
  });
});
