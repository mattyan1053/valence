/**
 * **誰に振られているかを読む**（#631）。
 *
 * **誰も見ていない PR が、盤面では他と同じ顔で並んでいた。** **assignee も
 * レビュー依頼も、どこにも出ていなかった。**
 *
 * **「アサインが無い」と「取れなかった」を分ける**（`AGENTS.md` §5）
 * ——**このリポジトリが #60 / #62 / #64 / #67 / #76 / #86 で繰り返し塞いだ形**である。
 * **既定の分岐に倒し先を置かない**（`READINESS_OF_STATE` と同じ理由）。
 *
 * **推奨レビュー順（#632）とは別の軸**である。**あちらは「次に動くのが誰か（役割）」**、
 * **ここは「誰に振られているか（人）」**——**混ぜない。**
 *
 * **純粋関数である**（§3）。
 */

/** その PR に振られている人。**読めた PR のぶんだけ在る。** */
export type Assignment = {
  /** assignee の login。**空なら「誰も持っていない」**（**読めなかった、ではない**）。 */
  readonly assignees: readonly string[];
  /**
   * レビュー依頼の宛先。**個人の login と team の slug が混ざる。**
   *
   * **混ぜてよい**——**どちらも「誰かに出ている」**であり、
   * **team だけに出ている PR を「誰にも出ていない」と言わないため**である。
   */
  readonly reviewers: readonly string[];
  /**
   * 著者が bot か。
   *
   * **未アサインの内訳を出すために運ぶ**（#631 の判断どころ）——
   * **「未アサインが 5 件」の 5 件が全部 Dependabot なら、その数字は何も言っていない。**
   */
  readonly authoredByBot: boolean;
};

/**
 * その PR の状態。
 *
 * **`unknown` を持つ**——**読めなかったものを `unassigned` へ倒すと、
 * 「誰も見ていない」が「取れなかった」を飲み込む。**
 */
export type AssignmentState = "assigned" | "review-requested" | "unassigned" | "unknown";

/**
 * **誰に振られているか。**
 *
 * **アサインを先に見る。** **持ち主が決まっているほうが強い**
 * ——**レビュー依頼は「見てほしい」であって、「持っている」ではない。**
 */
export function assignmentStateOf(assignment: Assignment | undefined): AssignmentState {
  if (assignment === undefined) {
    return "unknown";
  }
  if (assignment.assignees.length > 0) {
    return "assigned";
  }
  return assignment.reviewers.length > 0 ? "review-requested" : "unassigned";
}

/** 盤面ぶんの数。**「読めなかった」を別に数える。** */
export type AssignmentSummary = {
  readonly total: number;
  /** **誰にも振られていない件数。** */
  readonly unassigned: number;
  /** **そのうち、著者が bot のもの。** **除かずに内訳として出す。** */
  readonly unassignedBots: number;
  /** **状態を読めなかった件数。** **未アサインには数えない。** */
  readonly unknown: number;
};

/**
 * **盤面ぶんを数える。**
 *
 * **bot の PR を除かない**（#631 の判断どころ）。**除くと「未アサイン 0 件」に見え**、
 * **Dependabot の PR を誰も見ていない事実が消える**——**#625 は
 * `package.json` と lock だけの変更なのに、人の手が 1 行要った。**
 * **数えて内訳を出せば、読む側が判断できる。**
 */
export function summarizeAssignments(
  numbers: readonly number[],
  assignments: ReadonlyMap<number, Assignment>,
): AssignmentSummary {
  let unassigned = 0;
  let unassignedBots = 0;
  let unknown = 0;

  for (const number of numbers) {
    const assignment = assignments.get(number);
    switch (assignmentStateOf(assignment)) {
      case "unknown":
        unknown += 1;
        break;
      case "unassigned":
        unassigned += 1;
        if (assignment?.authoredByBot === true) {
          unassignedBots += 1;
        }
        break;
      default:
        break;
    }
  }
  return { total: numbers.length, unassigned, unassignedBots, unknown };
}
