/**
 * レビュアーが見る画面。**依存の順に並べ、各行にリスク Tier を載せる。**
 *
 * 部品は既にある（#107 の依存グラフ、#110 のリスク Tier）。**ここは合成だけで、
 * どちらも作り直さない。** 並びの持ち主は依存グラフのほうなので、行を組み立て直さず
 * その口（`renderAside`）へ載せる。
 *
 * **Tier で並べ替えない。** 依存の順は**守らないとマージできない制約**で、
 * Tier は**優先度の目安**でしかない。混ぜると「急ぐべき PR が先に見える」せいで
 * **土台より先に積み荷をマージしようとする**——このプロダクトが解こうとしている問題を、
 * 画面が作り出すことになる。
 */

import type { ReactNode } from "react";
import type { DependencyEdge, PullRequestRef } from "../../domain/graph/dependency-graph";
import type { DependencyOrder } from "../../domain/graph/dependency-order";
import type { MergeBlock } from "../../domain/graph/merge-block";
import type { MergeStatusReport } from "../../domain/graph/merge-readiness";
import { mergeReadinessOf } from "../../domain/graph/merge-readiness";
import type { Assignment } from "../../domain/triage/assignment";
import type { ReviewOpinion } from "../../domain/triage/ball";
import { ballOf } from "../../domain/triage/ball";
import { filterByBall } from "../../domain/triage/board-filter";
import { fileOverlapsFor } from "../../domain/triage/file-overlap";
import type { ChangeSummary } from "../../domain/triage/risk-tier";
import { classifyRiskTier } from "../../domain/triage/risk-tier";
import { titleOverlapsFor } from "../../domain/triage/title-overlap";
import { assignmentNote } from "../assignment/assignment-note";
import type { BallFilter } from "../ball/ball-filter";
import { BALL_FILTERS } from "../ball/ball-filter";
import { BallFilterView } from "../ball/ball-filter-view";
import { ballNote } from "../ball/ball-note";
import type { UnreadablePullRequest } from "../dependency-graph/dependency-graph-view";
import { DependencyGraphView } from "../dependency-graph/dependency-graph-view";
import { fileOverlapNote } from "../file-overlap/file-overlap-note";
import { baseLagNote, mergeReadinessNote } from "../merge/merge-readiness-note";
import { RiskTierView } from "../risk-tier/risk-tier-view";
import { SHARED_TITLE_FLOOR, titleOverlapNote } from "../title-overlap/title-overlap-note";

/**
 * **材料が無い理由を、画面の語彙にする**（#573）。
 *
 * **3 つを 1 つの文にしていた**——**打ち切った / 読めなかった / 本当に材料が無い。**
 * **利用者に見えたのは全 PR で同じ 1 文**で、**どれなのかはどこにも残らなかった。**
 *
 * **実測（2026-09-02）**: **取得は成功していて 5627 ms**、**期限は 5000 ms**
 * ——**毎回打ち切られていた。** **「取れなかった」ではなく「待たなかった」**である。
 * **同じ文言だと、権限を疑いに行く**（**実際にそうなった**）。
 *
 * **知らない語でも黙らない。** **語彙が増えた日に行が消えると、また同じ顔になる。**
 */
export function changeUnavailableNote(kind: string): string {
  switch (kind) {
    case "timedout":
      // **待たなかったのであって、取れなかったのではない**
      return "リスク判定の材料が、時間内に返りませんでした";
    case "unreadable":
      return "リスク判定の材料を読めませんでした";
    default:
      // **語彙が増えても、行は残す**——**理由は記録の側にある**
      return `リスク判定の材料がありません（${kind}）`;
  }
}

/**
 * **押すものと、押した結果を、横に並べる**（#585 のレビュー。**人が見て言った**）。
 *
 * > approve と merge が縦にならんでて、ボタンのサイズが文字列長に影響されてズレてる
 *
 * **走らせて確かめた**——**行は `<li class="flex flex-col …">`** で、
 * **`renderActions` が返すのは `<form>` 2 つ**（POST 先が別なので**1 つにまとめられない**）
 * ——**そのまま flex item になるので縦に積まれる。**
 *
 * **器はここに置く**——**両者を合成する唯一の場所**であり、**`ApproveButton` /
 * `MergeButton` は互いを知らない**（**片方に置くと、もう片方が外に出る**）。
 *
 * **`flex-wrap` にする**——**幅が足りない画面で、はみ出すより折り返すほうがよい。**
 *
 * **幅もここで揃える**——**`Approve` と `Merge` は字数が違う**ので、**書かなければ
 * 文字幅で決まり、並べたときにズレる。** **並ぶときに揃えるのは、並べる側の仕事**
 * である（**部品は互いを知らない**）。
 */
/**
 * 行に足す 1 文。**言うことが無ければ出さない**（#248 / #597）。
 *
 * **行はもう長い**ので、**「出すか出さないか」を 1 箇所に集める**
 * ——**足すたびに三項演算子が増えると、`renderAside` が読めなくなる。**
 */
function Note({ text }: { readonly text: string | undefined }) {
  return text === undefined ? undefined : <span className="text-sm">{text}</span>;
}

function ActionRow({ children }: { readonly children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 [&_button]:min-w-24">{children}</div>;
}

export type ReviewBoardProps = {
  readonly pullRequests: readonly PullRequestRef[];
  readonly edges: readonly DependencyEdge[];
  readonly order: DependencyOrder;
  readonly invalid: readonly UnreadablePullRequest[];
  /**
   * PR 番号から引ける判定材料。
   *
   * **Tier ではなく材料を受け取る。** Tier を渡させると、**材料と食い違ったものを
   * 渡せてしまう**（#110 のレビューで実際に問題になった形）。判定は
   * `classifyRiskTier` に任せるので、**画面の中で理由が食い違わない**。
   *
   * **揃っていない PR があってよい。** 取得はこの層の仕事ではなく、
   * 揃うまでの間も画面は出る。
   */
  readonly changes: ReadonlyMap<number, ChangeSummary>;
  /**
   * **材料が無い理由**（#573）。**PR 番号から `kind` を引く**。
   *
   * **受けるのは `kind` だけ**である——**`reason` には応答の値が入りうる**
   * （`AGENTS.md` §6。#506 と同じ判断）。**判定の語彙は `application` の側にあるが、
   * ここは文字列として受ける**（**`ui` は `application` を import できない**）。
   */
  readonly changeUnavailableOf?: (number: number) => string | undefined;
  /**
   * 各行へ足す操作（#330）。
   *
   * **並びを作り直さないための口**である（`renderAside` と同じ理由）——
   * **操作を足すために行を組み立て直すと、画面から PR が消える穴が復活する。**
   *
   * **任意にしてよい。** **渡さなければ操作が出ないだけ**で、
   * **「抜けが無い」と言い切る類の値ではない**（`invalid` とは違う）。
   */
  readonly renderActions?: (pullRequestNumber: number) => ReactNode;
  /**
   * 各行へ足す**状態の表示**（#343）。
   *
   * **操作（`renderActions`）と分ける。** **押すものと、押した結果として出るものは
   * 別**である——**混ぜると、状態を足すたびに操作の口を触ることになる。**
   *
   * **任意にしてよい。** **渡さなければ出ないだけ**で、
   * **「抜けが無い」と言い切る類の値ではない**（`invalid` とは違う）。
   */
  readonly renderStatus?: (pullRequestNumber: number) => ReactNode;
  /**
   * **その PR の head の commit が分かっているか**（#541 のレビュー）。
   *
   * **盤面はこれを持っていない**（`changes` は判定材料で、commit ではない）ので、
   * **渡す側から受ける**——**`MergeButton` へ渡している `headSha` と、同じもの**である。
   *
   * **任意にしない。** **どちらへ倒しても嘘になる**（`NodeMark.headKnown`）。
   */
  readonly headKnown: (pullRequestNumber: number) => boolean;
  /**
   * **その PR のタイトル**（#542）。**取れていないなら `undefined`。**
   *
   * **盤面はこれを持っていない**（`changes` は判定材料である）ので、**渡す側から受ける。**
   *
   * **任意にしない。** **渡し忘れると、どの箱も「タイトル不明」になる**
   * ——**取れているのに取れていないと言う**（`NodeMark.title`）。
   */
  readonly titleOf: (pullRequestNumber: number) => string | undefined;
  /** **その PR の GitHub 上の場所**（#621）。**渡す先は行である。** */
  readonly urlOf: (pullRequestNumber: number) => string;
  /**
   * **その PR の合流の状況**（#629）。**取れていないなら `undefined`。**
   *
   * **盤面はこれを持っていない**（`changes` はリスク判定の材料である）ので、
   * **渡す側から受ける**——**`heads` / `titles` と同じ形**である。
   *
   * **任意にしない。** **渡し忘れると、どの行も conflict を黙る**
   * ——**#629 が消しに来た状態**である（**押すまで分からない**）。
   * **`undefined` は「分からない」として出る**ので、**黙るのとは違う。**
   */
  readonly mergeStatusOf: (pullRequestNumber: number) => MergeStatusReport | undefined;
  /**
   * **その PR が誰に振られているか**（#631）。**読めていないなら `undefined`。**
   *
   * **盤面はこれを持っていない**ので、**渡す側から受ける**（`mergeStatusOf` と同じ形）。
   *
   * **任意にしない。** **渡し忘れると、どの行も持ち主を黙る**
   * ——**#631 が消しに来た状態**である（**誰も見ていない PR が、他と同じ顔で並ぶ**）。
   */
  readonly assignmentOf: (pullRequestNumber: number) => Assignment | undefined;
  /**
   * **その PR に出ているレビューの意見**（#636）。**読めていないなら `undefined`。**
   *
   * **盤面はこれを持っていない**ので、**渡す側から受ける**（`mergeStatusOf` と同じ形）。
   *
   * **任意にしない。** **渡し忘れると、どの行も「誰の番か」を黙る**
   * ——**盤面を見て最初に知りたいのは、そこ**である。
   */
  readonly reviewOpinionOf: (pullRequestNumber: number) => ReviewOpinion | undefined;
  /**
   * **その PR に依存が残っているか**（#652 のレビュー）。**読めていないなら `undefined`。**
   *
   * **判定は `mergeBlockFor` が持つ**（#345 で 1 本にしたもの）——**ここで呼び直さない。**
   * **行ごとに呼ぶと、辺と順序を本数ぶんなめ直す**（#541 のレビュー）ので、
   * **呼ぶ側が 1 度だけ作ったものを配る。**
   *
   * **任意にしない。** **渡し忘れると、依存で押せない PR に「いま入れられます」と出る**
   * ——**同じ画面が逆のことを言う。**
   */
  readonly mergeBlockOf: (pullRequestNumber: number) => MergeBlock | undefined;
  /**
   * **一覧を、誰の番かで絞る**（#663）。**渡さなければ絞らない。**
   *
   * **既定は絞らない**——**開いた瞬間に一部しか見えていないと、
   * 見えていないことに気づけない。**
   *
   * **判定は足さない**——**`ballOf`（#636）が返したものを、通すか落とすかに使う。**
   * **絞るのは一覧だけ**で、**図は絞らない**（`rowShown`）。
   */
  readonly ballFilter?: BallFilter;
};

export function ReviewBoard({
  pullRequests,
  edges,
  order,
  invalid,
  changes,
  changeUnavailableOf,
  renderActions,
  renderStatus,
  headKnown,
  titleOf,
  urlOf,
  mergeStatusOf,
  assignmentOf,
  reviewOpinionOf,
  mergeBlockOf,
  ballFilter,
}: ReviewBoardProps) {
  // **行ごとに計算しない**（`mergeBlocksFor` と同じ理由）——**1 件ずつ比べると
  // 本数の 2 乗**になる。**材料が取れていない PR も渡す**——**「触っていない」
  // ではない**ので、**渡さないと、その PR とは重ならないと言うことになる**（#637）
  const overlaps = fileOverlapsFor(
    // **読めなかった PR も測り切れていない側である**（#651 のレビュー 3 周目）
    // ——**候補には混ぜられない**（**番号が読めないので `index` で持っている**）
    invalid.length,
    pullRequests.map((pullRequest) => ({
      number: pullRequest.number,
      changedPaths: changes.get(pullRequest.number)?.changedPaths,
    })),
  );
  // **同じ題の PR も、行ごとに計算しない**（#630。上と同じ理由）——
  // **ファイルの重なりとは別の軸**である（**#637 は「順序に影響する」、
  // こちらは「どちらか要らないかもしれない」**）
  const titleOverlaps = titleOverlapsFor(
    pullRequests.map((pullRequest) => ({
      number: pullRequest.number,
      title: titleOf(pullRequest.number),
    })),
    // **どこから言うかは画面が決める**（#630）——**domain へ渡して、
    // 「この長さ以上は取りこぼさない」を守らせる**（#653 のレビュー 2 周目）
    SHARED_TITLE_FLOOR,
    invalid.length,
  );

  // **誰の番かは、行ごとに 1 度だけ決める**（#663）——**絞りと行の文の両方が
  // 同じ答えを使う。** **2 度呼ぶと、片方だけが変わった日に画面が食い違う**
  const balls = pullRequests.map((pullRequest) => ({
    number: pullRequest.number,
    ball: ballOf({
      opinion: reviewOpinionOf(pullRequest.number),
      readiness: mergeReadinessOf(mergeStatusOf(pullRequest.number)).kind,
      block: mergeBlockOf(pullRequest.number),
      assignment: assignmentOf(pullRequest.number),
    }),
  }));
  const ballOfNumber = new Map(balls.map((row) => [row.number, row.ball]));
  const filtered = filterByBall(balls, ballFilter);
  const shown = new Set(filtered.shown);

  return (
    <>
      {/* **絞る口は、一覧の手前に置く**——**何が出ているかの断りでもある** */}
      <BallFilterView
        current={ballFilter}
        counts={{
          shown: filtered.shown.length,
          hidden: filtered.hidden,
          // **判定できなかった PR を数える**（#694 のレビュー）。**2 つある。**
          //
          // **1. 一覧に並んでいないもの**（#107 の `invalid`）。
          // **2. 並んでいるが「分からない」に倒れたもの**（**レビュー 2 周目**）
          // ——**`opinion` か `assignment` を読めなかった行**は `unknown` になる
          // （`ballOf`）。**本当はその番だったかもしれない。**
          //
          // **横断の盤面と同じ穴**である——**片方だけ直さない**（§5）
          undecided:
            invalid.length +
            // **「分からない」は選択肢に無い**（`BALL_FILTERS`）ので、**`unknown` の行は
            // 必ず隠れる側**である——**型がそれを言っている**（**`BallFilter` に
            // `unknown` は入らない**）
            balls.filter((one) => one.ball === "unknown").length,
        }}
        options={BALL_FILTERS}
      />
      <DependencyGraphView
        pullRequests={pullRequests}
        edges={edges}
        order={order}
        invalid={invalid}
        // **絞りは一覧だけに効く**（#663）——**図は絞らない。**
        // **依存の関係は、絞ると辺が消えて嘘になる**
        rowShown={(number) => shown.has(number)}
        // **図の箱にも危なさを載せる**（#540）。**脇の文章にしか無いと、
        // 10 本並んだとき全部読むまで順番が決まらない**——**判定は同じ
        // `classifyRiskTier`** なので、**箱と脇で食い違わない。**
        tierOf={(number) => {
          const change = changes.get(number);
          // **材料が無いことを「危なくない」に倒さない**（下の行と同じ判断）
          return change === undefined ? undefined : classifyRiskTier(change);
        }}
        headKnown={headKnown}
        titleOf={titleOf}
        urlOf={urlOf}
        renderAside={(number) => {
          const change = changes.get(number);
          // **材料の有無に関わらず出す**（#629）——**リスク Tier が揃っていないことと、
          // 合流できるかは別**である。**片方の行にだけ出すと、押せない理由が消える**
          // （`renderStatus` と同じ判断）
          const status = mergeStatusOf(number);
          // **2 行になりうる**（#639）。**同じことを 2 度言っているのではない**——
          // **`mergeReadinessNote` は「入るかどうか」**（`mergeStateStatus`）、
          // **`baseLagNote` は「どれだけ」**（compare の `behindBy`）で、**出どころが違う。**
          // **最新化を要求しない設定では、遅れていても `BEHIND` は返らない**（#644 のレビュー）
          // ので、**片方だけが出る場面がある。**
          const notes = [
            mergeReadinessNote(mergeReadinessOf(status)),
            baseLagNote(status?.behindBy),
          ].filter((line) => line !== undefined);
          const readiness = notes.map((line) => (
            <span className="text-sm" key={line}>
              {line}
            </span>
          ));
          // **持ち主は常に出す**（#631）——**合流の状況（上）とは違う。**
          // **あちらは「押せない理由」で平常時は言うことが無い**が、
          // **こちらは「誰の持ち物か」**であり、**振られていないこと自体が主題**である
          //
          // **押せるかの話が先、持ち主の話が後**である（#650 の取り込み直し）——
          // **base の遅れは合流の状況の側**なので、**`readiness` に並ぶ。**
          // **ファイルの重なりは、その間に入る**（#637）——**押せるかの話ではなく、
          // 持ち主の話でもない。** **依存の順序とは別の目安**である
          const overlap = fileOverlapNote(overlaps.get(number));
          // **重複しているかもしれない相手**（#630）——**「似ています」とは言わない。**
          // **言うことが無ければ出ない**（#248 / #597）。
          //
          // **ファイルの重なり（上）と同じ「順序の目安」の族**である
          // ——**#630 が「似ている」と「同じ」を分けた、その両側**（#653 の取り込み直し）
          const duplicate = titleOverlapNote(titleOverlaps.get(number));
          // **誰の番か**（#636）——**「誰の持ち物か」（下）とは別の軸**である。
          // **判定は domain が持つ**（`ballOf`）ので、**ここは詰め替えるだけ**である。
          //
          // **「誰の持ち物か」の直前に置く**——**役割の話が先、人の話が後**である。
          //
          // **絞りと同じ答えを使う**（#663）——**上で 1 度だけ決めたものを引く。**
          // **ここで呼び直すと、絞りに当たっていない行に別のことが書ける**
          const ball = ballNote(ballOfNumber.get(number) ?? "unknown");
          const assignment = (
            <span className="text-sm opacity-70">{assignmentNote(assignmentOf(number))}</span>
          );
          // **材料が無い PR を黙って落とさない。** 行は残し、
          // 「出せなかった」ことが分かる形にする（#107 の `invalid` と同じ形）。
          if (change === undefined) {
            const kind = changeUnavailableOf?.(number);
            // **材料が無くても操作は出す。** **Tier は目安**であって、
            // **承認してよいかの判断ではない**——**揃うまで押せないのは、
            // 交通整理をしに来た人を待たせるだけである**
            return (
              <>
                <span>
                  {kind === undefined
                    ? // **本当に材料が無い**（**取りに行った跡が無い**）
                      "リスク判定の材料がありません（まだ取得できていません）"
                    : changeUnavailableNote(kind)}
                </span>
                {readiness}
                <Note text={overlap} />
                <Note text={duplicate} />
                <Note text={ball} />
                {assignment}
                <ActionRow>
                  {renderStatus?.(number)}
                  {renderActions?.(number)}
                </ActionRow>
              </>
            );
          }
          return (
            <>
              <RiskTierView tier={classifyRiskTier(change)} change={change} />
              {readiness}
              <Note text={overlap} />
              <Note text={duplicate} />
              <Note text={ball} />
              {assignment}
              <ActionRow>
                {renderStatus?.(number)}
                {renderActions?.(number)}
              </ActionRow>
            </>
          );
        }}
      />
    </>
  );
}
