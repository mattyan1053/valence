/**
 * **承認を受け付ける口**（#330）。
 *
 * **infrastructure を直に触らない**（§3）。**合成ルートだけを呼ぶ。**
 *
 * **判定はここに書き写さない。** **押してよいかを決めるのは
 * `approvePullRequest`**——**ここがするのは、受け取った本文を内側の語彙へ直し、
 * 結果を押した人へ戻すことだけ**である。
 *
 * **結果は行き先に載せて戻す**（`?approve=<kind>`）。**押せなかった理由が
 * 伝わること**が、この Issue の完了条件のひとつである。
 */

import { redirect } from "next/navigation";
import type { ApprovePullRequestResult } from "../../../../../application/review-order/approve-pull-request";
import { approvePullRequestForCurrentUser } from "../../../../../composition/auth";
import type { ApproveNoticeKind } from "../../../../../ui/approve/approve-button";

/**
 * 送られてきた PR 番号を、数として読む。
 *
 * **フォームから来る値は文字列である。** **`Number()` に通しただけで使わない**
 * ——**`""` は `0` に、空白は無視され**、**どの PR とも違う相手へ要求が出る。**
 *
 * **1 以上の整数だけを通す**（**PR 番号がそれ以外になることは無い**）。
 */
export function pullRequestNumberFrom(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  // **形で確かめてから数にする**——**`Number()` は `1e3` も ` 42 ` も受ける**ので、
  // **通してよいものを並べる側で決める**（#90 と同じ形）
  const trimmed = value.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * 結果を、画面が出せる語彙へ寄せる。
 *
 * **`not-found` をそのまま返さない**（§6）——**見えないリポジトリの存在を教える。**
 * **ログインの状態も分けない**——**押した人にとっては「いま押せなかった」**である。
 */
export function approveOutcomeParam(result: ApprovePullRequestResult): ApproveNoticeKind {
  switch (result.kind) {
    case "approved":
      return "approved";
    case "forbidden":
      return "forbidden";
    case "self-approval":
      return "self-approval";
    default:
      // **`signed-out` / `needs-login` / `unavailable` / `not-found`**
      return "unavailable";
  }
}

export async function POST(
  request: Request,
  { params }: { readonly params: Promise<{ readonly owner: string; readonly name: string }> },
): Promise<Response> {
  const { owner, name } = await params;
  const form = await request.formData().catch(() => undefined);
  const number = pullRequestNumberFrom(form?.get("number"));

  const board = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  if (number === undefined) {
    // **読めない要求で GitHub を叩かない**
    redirect(`${board}?approve=unavailable`);
  }

  const result = await approvePullRequestForCurrentUser({ owner, name }, number);
  redirect(`${board}?approve=${approveOutcomeParam(result)}`);
}
