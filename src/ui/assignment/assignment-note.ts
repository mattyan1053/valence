/**
 * **誰に振られているかを、行の言葉にする**（#631）。
 *
 * **誰も見ていない PR が、盤面では他と同じ顔で並んでいた。**
 *
 * **判定はしない**（`mergeReadinessNote` と同じ）——**`assignmentStateOf` が返した
 * ものに、画面の語彙を当てるだけ**である。
 *
 * **「アサインが無い」と「取れなかった」を言い分ける**（`AGENTS.md` §5）。
 *
 * **常に 1 文出す。** **合流の状況（#629）とは違う**——**あちらは「押せない理由」で、
 * 平常時は言うことが無い**が、**こちらは「誰の持ち物か」**であり、
 * **振られていないこと自体がこの Issue の主題**である。
 */

import type { Assignment } from "../../domain/triage/assignment";
import { assignmentStateOf } from "../../domain/triage/assignment";

/**
 * その行に出す 1 文。
 *
 * **名前をそのまま出す。** **見えているのは、その人が閲覧権限を持つリポジトリの
 * PR だけ**である（`viewRepositoryBoard` が確かめている）——**GitHub の画面に
 * 出ているものと同じ。**
 */
export function assignmentNote(assignment: Assignment | undefined): string {
  switch (assignmentStateOf(assignment)) {
    case "unknown":
      // **「誰も持っていない」と混ぜない**——**混ぜると、読めなかった行を
      // 「放置されている」として拾いに行く**
      return "誰に振られているかを読めませんでした";
    case "unassigned":
      return "誰にも振られていません";
    case "review-requested":
      return `レビュー依頼: ${(assignment?.reviewers ?? []).join(", ")}`;
    case "assigned":
      return note(assignment);
  }
}

/**
 * **持ち主と、見てほしい相手を、両方出す。**
 *
 * **アサインがあるときにレビュー依頼を落とさない**——**別のこと**である
 * （**持っている人と、見てほしい人は違う**）。
 */
function note(assignment: Assignment | undefined): string {
  const assignees = `アサイン: ${(assignment?.assignees ?? []).join(", ")}`;
  const reviewers = assignment?.reviewers ?? [];
  return reviewers.length === 0 ? assignees : `${assignees}／レビュー依頼: ${reviewers.join(", ")}`;
}
