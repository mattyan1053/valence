"use server";

/**
 * 画面から Approve を押したときの入口（#315）。
 *
 * **infrastructure を直に触らない**（`AGENTS.md` §3）——**合成ルートだけを呼ぶ。**
 * **判断もここには無い**（`approvePullRequest` が持つ）。
 *
 * **結果は戻り先の query に載せて、画面が文にする。** **GitHub の応答は運ばない**
 * （§6）——**運ぶのは、境界が畳んだ分類の名前だけ**である。
 */

import { redirect } from "next/navigation";
import { approvePullRequestForCurrentUser } from "../../../../composition/auth";
import type { ApprovalOutcome } from "../../../../ui/review-actions/approval-notice";

/** 押した結果を、戻り先へ載せる名前へ畳む。 */
function outcomeOf(result: Awaited<ReturnType<typeof approvePullRequestForCurrentUser>>) {
  return result.kind === "refused" ? result.reason : result.kind;
}

export async function approveAction(formData: FormData): Promise<void> {
  const owner = String(formData.get("owner") ?? "");
  const name = String(formData.get("name") ?? "");
  const pullRequestNumber = Number(formData.get("pullRequestNumber"));

  // **数でなければ、GitHub を叩かない。** **外から来たものを検証してから使う**（§6）
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0) {
    redirect(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}?approve=gone`);
  }

  const outcome: ApprovalOutcome = outcomeOf(
    await approvePullRequestForCurrentUser({ owner, name, pullRequestNumber }),
  );
  redirect(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}?approve=${outcome}#pr-${pullRequestNumber}`,
  );
}
