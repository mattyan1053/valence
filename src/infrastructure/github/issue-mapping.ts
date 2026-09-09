/**
 * GitHub の issue 一覧（`GET /repos/{owner}/{repo}/issues`）をドメイン型へ変換する。
 *
 * **境界の仕事は 2 つだけ。** 応答を Zod で検証することと、ドメインの型へ移すこと。
 * **通信はここに置かない**（`pull-request-mapping` と同じ形）。
 *
 * **PR を落とすのもここ**である。**GitHub では PR も issue** なので、
 * **この口は PR も返す**——**内側に「PR でもある issue」を持ち込まない。**
 */

import { z } from "zod";
import type { InvalidIssue, IssueListing } from "../../application/ports/issue-source";
import type { IssueAssignment, IssueRef } from "../../domain/triage/issue";

/**
 * 使う項目だけを検証する。
 *
 * **タイトルの空文字は落とす**（`pull-request-mapping` と同じ判断）——**残すと、
 * 表示の側で「短いタイトル」と「取れなかった」が見分けられない。**
 */
const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
});

/**
 * **PR かどうかは `pull_request` の有無で決まる。**
 *
 * **他の項目で当てない**——**`html_url` に `/pull/` が入るのは「そう見える」だけ**で、
 * **URL の形が変わった日に、PR が issue として並ぶ。**
 */
const pullRequestMarkSchema = z.object({ pull_request: z.unknown() });

function isPullRequest(item: unknown): boolean {
  const parsed = pullRequestMarkSchema.safeParse(item);
  return parsed.success && parsed.data.pull_request !== undefined;
}

/**
 * 誰に振られているか。
 *
 * **issue 本体とは別に読む。** **ここが読めなくても行は残す**
 * ——**1 件の形が違うだけで盤面全部を捨てない**（`merge-status-mapping` と同じ形）。
 * **落ちたぶんは地図に入らない**ので、**`issueAssignmentStateOf` が `unknown` へ倒す。**
 */
const assignmentSchema = z.object({
  assignees: z.array(z.object({ login: z.string().min(1) })),
  /** **立てた人。** **`type` が `Bot` なら bot である**（`login` の形で当てない）。 */
  user: z.object({ type: z.string() }),
});

function toAssignment(item: unknown): IssueAssignment | undefined {
  const parsed = assignmentSchema.safeParse(item);
  if (!parsed.success) {
    return undefined;
  }
  return {
    assignees: parsed.data.assignees.map((assignee) => assignee.login),
    authoredByBot: parsed.data.user.type === "Bot",
  };
}

export function toIssueListing(items: readonly unknown[]): IssueListing {
  const issues: IssueRef[] = [];
  const invalid: InvalidIssue[] = [];
  const assignments = new Map<number, IssueAssignment>();

  for (const [index, item] of items.entries()) {
    // **PR は「読めなかった」ではない。** **数えると、盤面が読めていないように見える**
    if (isPullRequest(item)) {
      continue;
    }
    const parsed = issueSchema.safeParse(item);
    if (!parsed.success) {
      invalid.push({ index, reason: `issue を読めません: ${z.prettifyError(parsed.error)}` });
      continue;
    }
    issues.push({ number: parsed.data.number, title: parsed.data.title });
    const assignment = toAssignment(item);
    if (assignment !== undefined) {
      assignments.set(parsed.data.number, assignment);
    }
  }
  return { issues, invalid, assignments };
}
