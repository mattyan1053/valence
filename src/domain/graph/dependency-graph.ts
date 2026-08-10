/**
 * PR どうしの依存グラフ。
 *
 * スタックした PR（ある PR のブランチの上に次の PR を積む）を DAG として表す。
 * ここは純粋関数であり、GitHub API のレスポンス型ではなく自前の型を入力に取る。
 * 変換は infrastructure の責務。
 */

/**
 * ブランチの参照。
 *
 * **名前だけでは参照は決まらない。** public なリポジトリには fork からの PR が来るので、
 * upstream の `feature` と fork の `feature` が同時に居うる。名前一致で繋ぐと、
 * **存在しない依存が描かれる**。
 */
export type BranchRef = {
  /**
   * リポジトリの識別子。**中身は解釈しない不透明な文字列**で、
   * 「同じ文字列なら同じリポジトリ」とだけ決める。何を入れるかは境界が決める。
   */
  readonly repository: string;
  readonly branch: string;
};

/** 依存を決めるのに要る、PR の最小限の情報。 */
export type PullRequestRef = {
  readonly number: number;
  /** マージ先。 */
  readonly base: BranchRef;
  /** この PR が持ち込むブランチ。 */
  readonly head: BranchRef;
};

/** 「この PR は、あの PR の上に積まれている」を表す辺。 */
export type DependencyEdge = {
  /** 積んでいる側。base が相手の head を指している PR。 */
  readonly dependent: number;
  /** 先にマージされる必要がある PR。 */
  readonly dependsOn: number;
};

/**
 * PR の集合から辺を導く。
 *
 * **辺は「ある PR の base が、別の PR の head と同じ参照である」ことだけで決まる。**
 * 「base が `main` 以外か」では判定しない。既定ブランチ名はリポジトリごとに違い、
 * 埋め込むと別名のリポジトリで壊れる。既定ブランチは「どの PR の head でもない」
 * というだけで自然に外れる。
 *
 * **分からないものを辺にしない。** 対応する PR が見つからない base（既定ブランチや、
 * 閉じた PR の head）からは辺を作らない。推測で繋ぐと、存在しない依存が描かれる。
 */
export function buildDependencyEdges(
  pullRequests: readonly PullRequestRef[],
): readonly DependencyEdge[] {
  const byHead = indexByHead(pullRequests);

  const edges: DependencyEdge[] = [];
  for (const pullRequest of pullRequests) {
    const dependsOn = byHead.get(refKey(pullRequest.base));
    if (dependsOn === undefined || dependsOn === AMBIGUOUS) {
      continue;
    }
    // base と head が同じ PR は作れないが、変換の誤りで届きうる。
    // 通すと「自分を待つ PR」ができ、順序が決まらなくなる。
    if (dependsOn === pullRequest.number) {
      continue;
    }
    edges.push({ dependent: pullRequest.number, dependsOn });
  }
  return edges;
}

/**
 * head が同じ PR が 2 つ以上あることを表す印。
 *
 * 通常は起きないが、閉じた PR を含めると起こりうる。**どちらに積まれたのかを
 * 決められない**ので、片方を選ばずに辺を作らない（分からないものを辺にしない）。
 */
const AMBIGUOUS = Symbol("ambiguous head ref");

/**
 * 参照を突き合わせるための鍵。
 *
 * **区切り文字で連結しない。** 識別子もブランチ名も境界から来る文字列なので、
 * 区切りを含む名前で**別の組と衝突させられる**。JSON は値ごとに引用符とエスケープが
 * 付くので、組が一意に決まる。
 */
function refKey(ref: BranchRef): string {
  return JSON.stringify([ref.repository, ref.branch]);
}

function indexByHead(
  pullRequests: readonly PullRequestRef[],
): ReadonlyMap<string, number | typeof AMBIGUOUS> {
  const byHead = new Map<string, number | typeof AMBIGUOUS>();
  for (const pullRequest of pullRequests) {
    const key = refKey(pullRequest.head);
    byHead.set(key, byHead.has(key) ? AMBIGUOUS : pullRequest.number);
  }
  return byHead;
}
