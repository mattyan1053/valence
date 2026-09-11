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
import { assignmentNote } from "../assignment/assignment-note";
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
};

export type CrossRepositoryBoardProps = {
  readonly rows: readonly CrossRepositoryRow[];
  readonly unavailable: CrossRepositoryUnavailable;
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

export function CrossRepositoryBoard({ rows, unavailable }: CrossRepositoryBoardProps) {
  const note = unavailableNote(unavailable);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-semibold text-lg">横断の一覧（{rows.length} 本）</h2>
      {/* **読めなかったことを残す**——**黙ると、盤面は静かに不完全になる** */}
      {note === undefined ? undefined : <p className="text-sm opacity-70">{note}</p>}
      {rows.length === 0 ? (
        <p className="text-sm">open な PR はありません。</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => {
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
