/**
 * **その PR を、いまマージしてよいか**を依存グラフから決める（#345）。
 *
 * **依存グラフを描く道具が、依存を壊せるボタンを持っていた。**
 * **PR-B の base が PR-A の head のとき、B を先にマージすると `feat/a` に B の変更が
 * 入る**——**A を承認したレビュアーが見たものと、A に入っているものが変わる。**
 * **このプロダクトが解こうとしている問題そのもの**である（`AGENTS.md` §1）。
 *
 * **「依存が残る」の定義は、辺の作り方がすでに決めている。**
 * **`buildDependencyEdges` は、base に対応する open な PR が一覧に居るときだけ辺を作る**
 * ——**閉じた PR やマージ済みの head からは辺を作らない**（「分からないものを辺にしない」）。
 * **したがって「辺の `dependent` に居る」＝「まだ open な土台を待っている」**である。
 * **base の PR が閉じている場合は、辺が無いので自然に `ready` になる。**
 *
 * **循環は別に扱う。** **順序が付かない**ので、**「何を先に入れればよいか」も言えない**
 * ——**押させない。** **`order.cyclic` には循環そのものだけでなく、その先に積まれた
 * ものも入る**（`DependencyOrder`）ので、**そちらも同じ扱いになる。**
 *
 * **純粋関数である**（§3）。**一覧をどこから取るかは、この層の関心ではない。**
 */

import type { DependencyEdge } from "./dependency-graph";
import type { DependencyOrder } from "./dependency-order";

export type MergeBlock =
  /** 依存は残っていない。**マージしてよい。** */
  | { readonly kind: "ready" }
  /**
   * **先に入れるものがある。**
   *
   * **番号を返す**——**「押せない」だけでは、何をすればよいか分からない**
   * （#345 の完了条件）。
   */
  | { readonly kind: "depends-on"; readonly numbers: readonly number[] }
  /**
   * **順序を判定できないので、マージさせない。**
   *
   * **3 つの場合が入る。**
   *
   * 1. **循環している**（その先に積まれたものも含む）
   * 2. **その番号が一覧に出てこない**
   * 3. **一覧に読めなかった PR がある**（#348 のレビュー）——**辺が作られないので、
   *    どの行の「依存なし」も信じられない**
   *
   * **どれも「並べられなかった」**で、**押した人が次にすることも同じ**
   * （**GitHub で PR を見る**）。
   *
   * **`cyclic` と名付けない。** **循環していない場合に「循環しています」と言うと、
   * 嘘の理由が伝わる**——**押させないことは同じでも、理由は違う。**
   * **原因を画面で言い分けない**——**言い分けるには理由を運ぶ必要があり、
   * それはこの判定の関心事ではない。**
   */
  | { readonly kind: "not-orderable" };

/**
 * **その番号がマージしてよいか。**
 *
 * `edges` と `order` は、**同じ一覧から作ったものを渡す**
 * （`buildDependencyEdges` / `orderByDependency`）。
 *
 * **循環を先に見る。** **循環に居るものは辺も持つ**が、**「#8 を先に」と言えてしまうと
 * 嘘になる**——**その #8 もこの PR を待っている。**
 *
 * **食い違っていても緩い側へ倒さない。** **辺に無くても循環に居ればマージさせない**
 * ——**判定できないものを「安全」に倒さない**（§5）。
 */
export function mergeBlockFor(
  number: number,
  edges: readonly DependencyEdge[],
  order: DependencyOrder,
  unreadableCount: number,
): MergeBlock {
  return blockFrom(number, indexFor(edges, order), unreadableCount);
}

/**
 * **一覧ぶんをまとめて判定する**（#541 のレビュー）。
 *
 * **1 件ずつ呼ぶと、辺と順序を毎回なめ直す**——**盤面は全部の行について呼ぶ**ので、
 * **本数の 2 乗**になる（**open な PR が数百あるリポジトリで、図を描くだけで効く**）。
 *
 * **判定は `mergeBlockFor` と同じものである**（**下の `blockFrom` を、どちらも呼ぶ**）
 * ——**速さのために規則を書き写さない。** **書き写すと、片方だけ直した日から、
 * 図と Merge ボタンが違うことを言う。**
 *
 * **訊かれた番号だけを返す。** **一覧に無い番号は `not-orderable`** である
 * （`mergeBlockFor` と同じ）。
 */
export function mergeBlocksFor(
  numbers: readonly number[],
  edges: readonly DependencyEdge[],
  order: DependencyOrder,
  unreadableCount: number,
): ReadonlyMap<number, MergeBlock> {
  const index = indexFor(edges, order);
  return new Map(numbers.map((number) => [number, blockFrom(number, index, unreadableCount)]));
}

/**
 * 判定に使う索引。**辺と順序を、1 度だけなめて作る。**
 *
 * **`dependsOn` は辺の並びを保つ。** **「何を先に入れるか」は画面へそのまま出る**ので、
 * **並びが呼ぶたびに変わると、読み手には理由の分からない揺れになる。**
 */
type OrderIndex = {
  readonly dependsOn: ReadonlyMap<number, readonly number[]>;
  readonly cyclic: ReadonlySet<number>;
  readonly ordered: ReadonlySet<number>;
};

function indexFor(edges: readonly DependencyEdge[], order: DependencyOrder): OrderIndex {
  const dependsOn = new Map<number, number[]>();
  for (const edge of edges) {
    const found = dependsOn.get(edge.dependent);
    if (found === undefined) {
      dependsOn.set(edge.dependent, [edge.dependsOn]);
    } else {
      found.push(edge.dependsOn);
    }
  }
  return {
    dependsOn,
    cyclic: new Set(order.cyclic),
    ordered: new Set(order.ordered),
  };
}

/** **規則はここ 1 箇所にある。** 上の 2 つは、索引の作り方が違うだけである。 */
function blockFrom(number: number, index: OrderIndex, unreadableCount: number): MergeBlock {
  // **図に抜けがあるなら、どの行の「依存なし」も信じられない**（#348 のレビュー）。
  // **読めなかった PR は辺を持たない**ので、**土台だけが読めなかった場合、
  // 上段が「依存なし」に見える**——**しかもその経路は投げないので、
  // 呼ぶ側の `catch` にも入らない。**
  //
  // **既定値を置かない。** **書き忘れが「抜けは無い」へ倒れると、
  // この判定がまるごと素通りする**（#317 の `require` と同じ理由）。
  if (unreadableCount > 0) {
    return { kind: "not-orderable" };
  }

  if (index.cyclic.has(number)) {
    return { kind: "not-orderable" };
  }

  const numbers = index.dependsOn.get(number);
  if (numbers !== undefined && numbers.length > 0) {
    return { kind: "depends-on", numbers };
  }

  // **一覧に無い番号を「マージしてよい」と言わない。** **盤面を出してから押すまでに
  // 一覧は変わる**ので、**知らない番号は「並べられなかった」側と同じ扱いにする。**
  return index.ordered.has(number) ? { kind: "ready" } : { kind: "not-orderable" };
}
