/**
 * 依存グラフの置き場所を決める（#471）。
 *
 * **描かない。座標だけを返す。** **絵を見なくても、置き場所が正しいかを確かめられる**
 * ——**「どれがどれの上か」は座標で決まる**ので、そこを試験が持つ。
 *
 * **深さ（いくつ積まれているか）を左から右へ、同じ深さを上から下へ置く。**
 * **縦に積むと枝分かれが潰れる**——**箇条書きが読めないのと同じ理由**である。
 *
 * **描画ライブラリを入れていない。** **要るのは層に分けて線を引くことだけ**で、
 * **それは辺と順序から決まる**（`AGENTS.md` §5。**曲線や力学レイアウトが要ると
 * 判断したときに、理由と一緒に入れる**）。
 */

import type { DependencyEdge } from "../../domain/graph/dependency-graph";

/** 箱 1 つ。**`depth` が「いくつ積まれているか」**である。 */
export type GraphNode = {
  readonly number: number;
  readonly depth: number;
  readonly row: number;
  readonly x: number;
  readonly y: number;
};

/** 線 1 本。**土台の右端から、積んだものの左端へ。** */
export type GraphLink = {
  readonly from: number;
  readonly to: number;
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
};

export type GraphLayout = {
  readonly nodes: readonly GraphNode[];
  readonly links: readonly GraphLink[];
  readonly width: number;
  readonly height: number;
  readonly nodeWidth: number;
  readonly nodeHeight: number;
};

/**
 * **箱の大きさは、中に入るものが決める**（#540）。
 *
 * **番号だけなら 92x30 で足りていた。** **危なさと「何待ちか」が入った**ので、
 * **2 行ぶんの高さと、`待ち: #123 ほか2 件` が収まる幅**を取る——**溢れさせると、
 * 「読まずに拾える」ために足したものが読めなくなる。**
 */
const NODE_WIDTH = 176;
const NODE_HEIGHT = 54;
const COLUMN_GAP = 44;
const ROW_GAP = 12;

/**
 * 置き場所を決める。
 *
 * **`placed` は土台が先に並んでいること**（`DependencyOrder.ordered`）。
 * **並べられなかったもの（循環）や読めなかったものは、ここへ渡さない**
 * ——**渡す側が「図に出ていない」と言う**（**欠けた図を完全な図の顔で出さない**）。
 *
 * **`placed` に居ない相手への辺は落とす。** **どこへも繋がらない線を引かない**し、
 * **深さにも数えない。**
 */
export function layoutDependencyGraph(input: {
  readonly placed: readonly number[];
  readonly edges: readonly DependencyEdge[];
}): GraphLayout {
  const present = new Set(input.placed);
  const dependsOn = new Map<number, number[]>();
  for (const edge of input.edges) {
    if (!present.has(edge.dependent)) {
      continue;
    }
    dependsOn.set(edge.dependent, [...(dependsOn.get(edge.dependent) ?? []), edge.dependsOn]);
  }

  // **土台が先に並んでいるので、1 度なめれば深さが決まる**（**数が増えても線形**）。
  //
  // **深さが決まっていない相手は数えない。** **図に居ない相手（循環・読めなかったぶん）も、
  // まだ置いていない相手も、ここで同じ扱いになる**——**「居るかどうか」を別に見ない**
  // （**見ても同じ結果になるので、規則を 2 つ持たない**）。
  const depths = new Map<number, number>();
  for (const number of input.placed) {
    const deeper = (dependsOn.get(number) ?? [])
      .map((base) => depths.get(base))
      .filter((depth): depth is number => depth !== undefined);
    depths.set(number, deeper.length === 0 ? 0 : Math.max(...deeper) + 1);
  }

  const rows = new Map<number, number>();
  const nodes: GraphNode[] = input.placed.map((number) => {
    const depth = depths.get(number) ?? 0;
    const row = rows.get(depth) ?? 0;
    rows.set(depth, row + 1);
    return {
      number,
      depth,
      row,
      x: depth * (NODE_WIDTH + COLUMN_GAP),
      y: row * (NODE_HEIGHT + ROW_GAP),
    };
  });

  const byNumber = new Map(nodes.map((node) => [node.number, node]));
  const links: GraphLink[] = [];
  for (const edge of input.edges) {
    const from = byNumber.get(edge.dependsOn);
    const to = byNumber.get(edge.dependent);
    if (from === undefined || to === undefined) {
      continue;
    }
    links.push({
      from: edge.dependsOn,
      to: edge.dependent,
      fromX: from.x + NODE_WIDTH,
      fromY: from.y + NODE_HEIGHT / 2,
      toX: to.x,
      toY: to.y + NODE_HEIGHT / 2,
    });
  }

  return {
    nodes,
    links,
    width: Math.max(...nodes.map((node) => node.x + NODE_WIDTH), 0),
    height: Math.max(...nodes.map((node) => node.y + NODE_HEIGHT), 0),
    nodeWidth: NODE_WIDTH,
    nodeHeight: NODE_HEIGHT,
  };
}
