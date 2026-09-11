/**
 * **見えるリポジトリを跨いだ、open PR の一覧**（#682）。
 *
 * **1 リポジトリの盤面（`ReviewBoard`）とは出すものが違う。** **依存グラフ・
 * リスク Tier・同じファイルを触る組・重複の検知は、ここには無い**
 * ——**跨いで意味を持たない**か、**ファイル変更に依る（往復が増える）側**である（#662）。
 * **材料そのものを持っていない**ので、**出そうとすると往復が増えることに気づける。**
 *
 * **「読めなかった」を捨てない**（#681 / #682）——**読めたぶんを出したうえで、
 * 読めなかった数も出す。** **黙ると、盤面は静かに不完全になる。**
 *
 * **表示に専念する**（§3）。**行き先は props で受ける。**
 */

import type { MergeStatusReport } from "../../domain/graph/merge-readiness";
import { mergeReadinessOf } from "../../domain/graph/merge-readiness";
import type { Assignment } from "../../domain/triage/assignment";
import type { ReviewOpinion } from "../../domain/triage/ball";
import { ballOf } from "../../domain/triage/ball";
import { partitionByBall } from "../../domain/triage/board-filter";
import { crossReviewOrder } from "../../domain/triage/cross-review-order";
import { assignmentNote } from "../assignment/assignment-note";
import type { BallFilter } from "../ball/ball-filter";
import { BallFilterView } from "../ball/ball-filter-view";
import { ballNote } from "../ball/ball-note";
import { mergeReadinessNote } from "../merge/merge-readiness-note";

/** 一覧に並ぶ 1 本。**どのリポジトリのものかを、行が持つ。** */
export type CrossRepositoryRow = {
  readonly repository: { readonly owner: string; readonly name: string };
  readonly number: number;
  readonly title: string;
  /** 最後に動いた時刻（ISO 8601）。**そのまま出す**——**「新しい」とは言わない。** */
  readonly updatedAt: string;
  /** 現物への行き先。**組むのは `app`** である（`ui` は経路を知らない）。 */
  readonly href: string;
  /** **読めなかったものは `undefined`**（#681）——**既定値を埋めない。** */
  readonly opinion?: ReviewOpinion;
  readonly assignment?: Assignment;
  readonly mergeStatus?: MergeStatusReport;
};

/** 読めなかったリポジトリの数。**2 つを分ける**（#681）。 */
export type CrossRepositoryUnavailable = {
  /** **答えが返らなかった**（**1 本も出ていない**）。 */
  readonly unreadable: number;
  /** **多すぎて読み切れなかった**（**読めたぶんは出ている**）。 */
  readonly truncated: number;
  /** **リポジトリの一覧の側で読めなかった行**（**横断の一覧にも出てこない**）。 */
  readonly repositories: number;
  /**
   * **形を読み取れなかった PR の本数**（#686 のレビュー）。
   *
   * **黙って消すと、全部が検証で落ちた盤面が「open な PR はありません」になる。**
   */
  readonly pullRequests: number;
};

export type CrossRepositoryBoardProps = {
  readonly rows: readonly CrossRepositoryRow[];
  readonly unavailable: CrossRepositoryUnavailable;
  /**
   * **いま選ばれている絞り**（#683）。**絞っていなければ `undefined`。**
   *
   * **1 リポジトリの盤面（#663）と同じ口**である——**別の並びを作らない**
   * （**受ける値も出す選択肢も `BALL_FILTERS` から作る**）。
   */
  readonly ballFilter?: BallFilter;
};

/**
 * **読めなかったことを言う 1 文。** **言うことが無ければ `undefined`。**
 *
 * **3 つを分けて言う**——**「答えが返らなかった」「読み切れなかった」「一覧の側で
 * 読めなかった」は、次にすることが違う。**
 */
export function unavailableNote(unavailable: CrossRepositoryUnavailable): string | undefined {
  const parts = [
    unavailable.unreadable === 0 ? undefined : `${unavailable.unreadable} 件は読めませんでした`,
    unavailable.truncated === 0
      ? undefined
      : `${unavailable.truncated} 件は多すぎて読み切れませんでした（出ているのは一部です）`,
    unavailable.repositories === 0
      ? undefined
      : `${unavailable.repositories} 件はリポジトリの一覧の時点で読めませんでした`,
    unavailable.pullRequests === 0
      ? undefined
      : `${unavailable.pullRequests} 本は、PR の形を読み取れませんでした`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : `${parts.join("。")}。`;
}

/**
 * **誰の番か。**
 *
 * **依存は跨がない**ので、**先に入れる PR が残っているかは分からない**
 * ——**`ballOf` には渡さない。** **その結果「マージする人の番」は出ない**
 * （**`ballOf` は合流できることと依存が無いことの両方を要る**）——**言わない側へ倒れる。**
 */
function ballFor(row: CrossRepositoryRow) {
  return ballOf({
    opinion: row.opinion,
    readiness: mergeReadinessOf(row.mergeStatus).kind,
    block: undefined,
    assignment: row.assignment,
  });
}

export function CrossRepositoryBoard({ rows, unavailable, ballFilter }: CrossRepositoryBoardProps) {
  const note = unavailableNote(unavailable);
  // **誰の番かは、行ごとに 1 度だけ決める**（#663 と同じ形）——**絞りと行の文の
  // 両方が同じ答えを使う。** **2 度呼ぶと、片方だけが変わった日に画面が食い違う**
  const balls = rows.map((row) => ({ row, ball: ballFor(row) }));
  const filtered = partitionByBall(balls, ballFilter);
  // **並べるのは絞ったあと**——**根拠は `crossReviewOrder` が持つ**（§5。
  // **画面に書き写すと、向こうが変わった日にここだけ古くなる**）
  const shown = crossReviewOrder(filtered.shown.map((one) => one.row));
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-semibold text-lg">横断の一覧（{shown.length} 本）</h2>
      {/* **読めなかったことを残す**——**黙ると、盤面は静かに不完全になる。**
          **絞りの外に置く**（#663 の「気をつけること」）——**混ぜると、
          抜けが絞りのせいに見える** */}
      {note === undefined ? undefined : <p className="text-sm opacity-70">{note}</p>}
      {/* **絞る口は、絞っていなくても出す**——**無ければ、絞れることに気づけない** */}
      <BallFilterView
        current={ballFilter}
        counts={{
          shown: shown.length,
          hidden: filtered.hidden,
          // **盤面に出ていない PR を数える**（#694 のレビュー）——**4 つとも
          // 「行がここに無い」側**である（**読めなかった／読み切れなかった／
          // 一覧の時点で読めなかった／形を読み取れなかった**）。
          // **その番のものだったかもしれない**ので、**0 件と言い切らせない**
          unread:
            unavailable.unreadable +
            unavailable.truncated +
            unavailable.repositories +
            unavailable.pullRequests,
        }}
      />
      {shown.length === 0 ? (
        // **読めていない範囲が残るなら、0 件と断定しない**（#686 のレビュー）
        // ——**「読めませんでした」と言った直後に「ありません」と言うと、
        // 同じ画面が逆のことを言う**
        //
        // **絞って 0 件なら、ここでは言わない**（#683）——**「ありません」は嘘**である
        // （**あるが、この番のものが無い**）。**言うのは `ballFilterNote` の側**で、
        // **隠した件数と一緒に出る**（#410 が `EmptyNotice` で塞いだ形）
        ballFilter === undefined ? (
          <p className="text-sm">
            {note === undefined
              ? "open な PR はありません。"
              : "読めたぶんに、open な PR はありません。"}
          </p>
        ) : undefined
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((row) => {
            const ball = ballNote(ballFor(row));
            const readiness = mergeReadinessNote(mergeReadinessOf(row.mergeStatus));
            return (
              <li
                className="flex flex-col gap-1"
                key={`${row.repository.owner}/${row.repository.name}#${row.number}`}
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-mono text-sm opacity-70">
                    {row.repository.owner}/{row.repository.name}
                  </span>
                  <a className="underline" href={row.href}>
                    #{row.number} {row.title}
                  </a>
                  {/* **「新しい」とは言わない**——**時刻を出して、読む人が決める**（#664） */}
                  <span className="text-sm opacity-70">{row.updatedAt}</span>
                </div>
                <div className="flex flex-wrap gap-2 text-sm opacity-70">
                  {ball === undefined ? undefined : <span>{ball}</span>}
                  {readiness === undefined ? undefined : <span>{readiness}</span>}
                  {/* **「分からない」を「依頼なし」と出さない**——**判定は
                      `assignmentNote` が持つ**（読めなければ、そう言う） */}
                  <span>{assignmentNote(row.assignment)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
