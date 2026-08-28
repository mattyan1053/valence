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

import type { ReactNode } from "react";
import type { DependencyEdge, PullRequestRef } from "../../domain/graph/dependency-graph";
import type { DependencyOrder } from "../../domain/graph/dependency-order";
import { mergeBlocksFor } from "../../domain/graph/merge-block";
import type { RiskTier } from "../../domain/triage/risk-tier";
import { DependencyGraphFigure } from "./dependency-graph-figure";
import { layoutDependencyGraph } from "./graph-layout";

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
  /**
   * 各行へ足す表示。
   *
   * **ここに何を出すかは知らない。** 行の並び（順序・循環・どこにも並ばないもの）は
   * この部品が持っているので、**載せる側が並びを作り直さずに済む**ようにするための口である。
   * 作り直すと、片方だけ直して**画面から PR が消える**穴が復活する。
   */
  readonly renderAside?: (pullRequestNumber: number) => ReactNode;
  /**
   * 図の箱に載せる危なさ（#540）。**材料が届いていない PR は `undefined`。**
   *
   * **Tier そのものではなく、Tier を返す口で受ける。** **判定材料（`ChangeSummary`）は
   * この部品の関心ではない**——**持たせると、依存グラフが triage を知ることになる。**
   *
   * **任意でよい。** **渡さなければ「未判定」と出るだけ**で、
   * **「抜けが無い」と言い切る類の値ではない**（`invalid` とは違う）。
   * **「危なくない」へは倒れない**ので、渡し忘れは画面に出る。
   */
  readonly tierOf?: (pullRequestNumber: number) => RiskTier | undefined;
  /**
   * **その PR の head の commit が分かっているか**（#541 のレビュー）。
   *
   * **`MergeBlock` は依存の順序しか知らない**ので、**これを渡さないと、
   * 無効な Merge ボタンの隣に「押せる」と出る**（**`head.sha` が欠けた PR は
   * 図に残る**）。
   *
   * **任意にしない。** **どちらへ倒しても嘘になる**（`NodeMark.headKnown`）。
   */
  readonly headKnown: (pullRequestNumber: number) => boolean;
  /**
   * **その PR のタイトル**（#542）。**取れていないなら `undefined`。**
   *
   * **任意にしない。** **渡し忘れると、どの箱も「タイトル不明」になる**
   * ——**取れているのに取れていないと言う**のは、`invalid` と同じ嘘である。
   */
  readonly titleOf: (pullRequestNumber: number) => string | undefined;
};

/**
 * 「何の上に積まれているか」を、辺を 1 度なめて引けるようにする（#541 のレビュー）。
 *
 * **行ごとに `edges` を絞ると、本数の 2 乗になる**——**盤面は全部の行について引く。**
 * **並びは辺のとおりに保つ**（**呼ぶたびに変わると、読み手には理由の分からない揺れ**）。
 */
function dependsOnIndex(edges: readonly DependencyEdge[]): ReadonlyMap<number, readonly number[]> {
  const found = new Map<number, number[]>();
  for (const edge of edges) {
    const listed = found.get(edge.dependent);
    if (listed === undefined) {
      found.set(edge.dependent, [edge.dependsOn]);
    } else {
      listed.push(edge.dependsOn);
    }
  }
  return found;
}

function PullRequestRow({
  pullRequest,
  dependsOn,
  aside,
}: {
  pullRequest: PullRequestRef;
  dependsOn: readonly number[];
  aside?: ReactNode;
}) {
  return (
    <li>
      <span>#{pullRequest.number}</span> <code>{pullRequest.head.branch}</code>
      {dependsOn.length > 0 ? (
        <span> ← {dependsOn.map((number) => `#${number}`).join(", ")} の上</span>
      ) : (
        <span> ← {pullRequest.base.branch}</span>
      )}
      {aside}
    </li>
  );
}

/**
 * 1 件も並ばないときの断り（#410）。
 *
 * **空の `<ol>` で終わらせない。** **見出しだけの画面は、壊れているのか、
 * まだ何も無いのかを区別できない**——**入口の画面が #213 で踏んだのと同じ形**である
 * （**何も見えない画面で終わらせない**）。
 *
 * **「無い」と「読めなかった」を同じ静けさにしない**（`AGENTS.md` §5）。
 * **読めなかった PR があるなら、0 本ではない**——**それを「PR がありません」と
 * 出すと、抜けたことが消える。** **件数と理由は下の節が出す**ので、
 * **ここは「出せなかった」とだけ言う。**
 */
function EmptyNotice({ unreadable }: { unreadable: number }) {
  if (unreadable > 0) {
    return <p>読めた PR が 1 件もありません。</p>;
  }
  return <p>open な PR が 1 件もありません。GitHub で PR を出すと、依存の順にここへ並びます。</p>;
}

export function DependencyGraphView({
  pullRequests,
  edges,
  order,
  invalid,
  renderAside,
  tierOf,
  headKnown,
  titleOf,
}: DependencyGraphViewProps) {
  const byNumber = new Map(pullRequests.map((pullRequest) => [pullRequest.number, pullRequest]));
  const dependsOn = dependsOnIndex(edges);
  const rowsFor = (numbers: readonly number[]) =>
    numbers
      .map((number) => byNumber.get(number))
      .filter((pullRequest): pullRequest is PullRequestRef => pullRequest !== undefined)
      .map((pullRequest) => (
        <PullRequestRow
          key={pullRequest.number}
          pullRequest={pullRequest}
          dependsOn={dependsOn.get(pullRequest.number) ?? []}
          aside={renderAside?.(pullRequest.number)}
        />
      ));

  // **順序にも循環にも出ない PR を落とさない。** 順序の計算が変わっても、
  // 画面から PR が消えることは無い、を保つ。
  const placed = new Set([...order.ordered, ...order.cyclic]);
  const unplaced = pullRequests
    .map((pullRequest) => pullRequest.number)
    .filter((number) => !placed.has(number));

  // **図に出す番号ぶんを、まとめて 1 度で判定する**（#541 のレビュー）。
  // **箱ごとに呼ぶと、そのたびに辺と順序をなめ直す**——**本数の 2 乗**になる。
  const figured = [...order.ordered, ...unplaced];
  const blocks = mergeBlocksFor(figured, edges, order, invalid.length);

  return (
    <section>
      <h2>PR の依存</h2>
      {pullRequests.length === 0 ? (
        <EmptyNotice unreadable={invalid.length} />
      ) : (
        <>
          {/*
           **図と一覧の両方を出す** (#471)。**図は関係を追うため**、
           **一覧は 1 件ずつの中身のため**（**Tier・承認・Merge は行に付く**）——
           **並びはどちらも `order` が持つ**ので、**作り直さない。**
           */}
          <DependencyGraphFigure
            layout={layoutDependencyGraph({ placed: figured, edges })}
            missing={{ unordered: order.cyclic.length, unreadable: invalid.length }}
            // **「何待ちか」を書き写さない**（#540）。**Merge ボタンと同じ規則を、
            // 同じ入力で呼ぶ**（`mergeBlocksFor` は `mergeBlockFor` と同じ判定である）
            // ——**書き写すと、押せないボタンの隣に「押せる」と出る**
            // （#345 が閉じた形が、図の側で開く）。
            markOf={(number) => ({
              tier: tierOf?.(number),
              // **知らない番号を「押せる」へ倒さない**（`mergeBlockFor` と同じ判断）
              block: blocks.get(number) ?? { kind: "not-orderable" },
              // **札の広さを、判定に合わせる**（#541 のレビュー）——**`MergeBlock` は
              // 依存の順序しか知らない**ので、**押せるかどうかはここで足す。**
              headKnown: headKnown(number),
              // **番号だけでは「どれか」が分からない**（#542）
              title: titleOf(number),
            })}
          />
          <ol>{rowsFor(figured)}</ol>
        </>
      )}

      {order.cyclic.length > 0 && (
        <section>
          {/*
            **「循環している」と言い切らない。** `cyclic` には循環に含まれる PR だけでなく、
            **その先に積まれた PR** も入る（順序が決まらない点は同じだが、原因ではない）。
            言い切ると半分について事実と違ううえ、**その PR の base を付け替えても直らない**。
          */}
          <h3>並べられなかった（循環、またはその先に積まれている）</h3>
          <p>
            先にマージすべき順が決まりません。<strong>循環している PR の base</strong>
            を付け替えてください。ここには、その循環の先に積まれているだけの PR も並びます。
          </p>
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
