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
   * **順序に出てこないので、先に入れるものを名指しできない。**
   *
   * **2 つの場合が入る。** **循環している**（その先に積まれたものも含む）ときと、
   * **その番号が一覧に出てこない**ときである。**どちらも「並べられなかった」**で、
   * **押した人が次にすることも同じ**（**GitHub で PR を見る**）。
   *
   * **`cyclic` と名付けない。** **一覧に無いだけの番号に「循環しています」と言うと、
   * 嘘の理由が伝わる**——**押させないことは同じでも、理由は違う。**
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
): MergeBlock {
  if (order.cyclic.includes(number)) {
    return { kind: "not-orderable" };
  }

  const numbers = edges.filter((edge) => edge.dependent === number).map((edge) => edge.dependsOn);
  if (numbers.length > 0) {
    return { kind: "depends-on", numbers };
  }

  // **一覧に無い番号を「マージしてよい」と言わない。** **盤面を出してから押すまでに
  // 一覧は変わる**ので、**知らない番号は「並べられなかった」側と同じ扱いにする。**
  return order.ordered.includes(number) ? { kind: "ready" } : { kind: "not-orderable" };
}
