/**
 * 依存グラフを描く。
 *
 * **表示に専念する。** 取得も判定もしない（`ui` が import してよいのは
 * `domain` / 他の `ui` / React だけ）。入力は**ドメイン型**で、GitHub の応答型は受けない。
 *
 * **「読めなかった」「並べられなかった」を「無かった」にしない。** これは
 * このリポジトリが #60 / #62 / #64 / #67 / #76 / #86 で繰り返し塞いできた形で、
 * ここで塞がないと**欠けた図が完全な図の顔で出る**。
 *
 * **描画ライブラリを入れていない。** いま要るのは「土台が先、その上が後」という
 * 縦の並びだけで、それは順序が既に持っている。曲線や自動レイアウトが要ると
 * 判断したときに、理由と一緒に入れる。
 */

import type { DependencyEdge, PullRequestRef } from "../../domain/graph/dependency-graph";
import type { DependencyOrder } from "../../domain/graph/dependency-order";

/**
 * 読めなかった 1 件。
 *
 * **`application` の `InvalidPullRequest` を import しない。** `ui` は外側の層を
 * 知らないためで、同じ形をここで宣言する（渡す側が composition で突き合わせる）。
 */
export type UnreadablePullRequest = {
  readonly index: number;
  readonly reason: string;
};

/**
 * **`invalid` を任意にしない。** 既定値を許すと、渡し忘れた画面が
 * 「抜けは無い」と言い切ってしまう。呼ぶ側に必ず答えさせる。
 */
export type DependencyGraphViewProps = {
  readonly pullRequests: readonly PullRequestRef[];
  readonly edges: readonly DependencyEdge[];
  readonly order: DependencyOrder;
  readonly invalid: readonly UnreadablePullRequest[];
};

function dependsOnOf(edges: readonly DependencyEdge[], number: number): readonly number[] {
  return edges.filter((edge) => edge.dependent === number).map((edge) => edge.dependsOn);
}

function PullRequestRow({
  pullRequest,
  dependsOn,
}: {
  pullRequest: PullRequestRef;
  dependsOn: readonly number[];
}) {
  return (
    <li>
      <span>#{pullRequest.number}</span> <code>{pullRequest.head.branch}</code>
      {dependsOn.length > 0 ? (
        <span> ← {dependsOn.map((number) => `#${number}`).join(", ")} の上</span>
      ) : (
        <span> ← {pullRequest.base.branch}</span>
      )}
    </li>
  );
}

export function DependencyGraphView({
  pullRequests,
  edges,
  order,
  invalid,
}: DependencyGraphViewProps) {
  const byNumber = new Map(pullRequests.map((pullRequest) => [pullRequest.number, pullRequest]));
  const rowsFor = (numbers: readonly number[]) =>
    numbers
      .map((number) => byNumber.get(number))
      .filter((pullRequest): pullRequest is PullRequestRef => pullRequest !== undefined)
      .map((pullRequest) => (
        <PullRequestRow
          key={pullRequest.number}
          pullRequest={pullRequest}
          dependsOn={dependsOnOf(edges, pullRequest.number)}
        />
      ));

  // **順序にも循環にも出ない PR を落とさない。** 順序の計算が変わっても、
  // 画面から PR が消えることは無い、を保つ。
  const placed = new Set([...order.ordered, ...order.cyclic]);
  const unplaced = pullRequests
    .map((pullRequest) => pullRequest.number)
    .filter((number) => !placed.has(number));

  return (
    <section>
      <h2>PR の依存</h2>
      <ol>{rowsFor([...order.ordered, ...unplaced])}</ol>

      {order.cyclic.length > 0 && (
        <section>
          <h3>並べられなかった（循環している）</h3>
          <p>先にマージすべき順が決まりません。どれかの base を付け替えてください。</p>
          <ul>{rowsFor(order.cyclic)}</ul>
        </section>
      )}

      {invalid.length > 0 && (
        <section>
          <h3>この図には抜けがあります</h3>
          <p>読めなかった PR が {invalid.length} 件あります。依存が欠けている可能性があります。</p>
          <ul>
            {invalid.map((entry) => (
              <li key={entry.index}>
                {entry.index + 1} 件目: {entry.reason}
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
