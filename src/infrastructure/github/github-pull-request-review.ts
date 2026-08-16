/**
 * `PullRequestReviews` の GitHub 実装（#330）。
 *
 * **押した人のトークンで出す**（`AGENTS.md` §6）。**installation トークンで
 * 代用しない**——**あれで出すと GitHub から見た承認者は App になり**、
 * **「自分の PR は自分で承認できない」を迂回でき**、**その承認が保護ルールの
 * 必要承認数に数えられる**（**人の判断で #317 から持ち越された条件**）。
 *
 * **自己承認をこちらで数え直さない。** **ユーザートークンで出せば GitHub が弾く**
 * ——**同じ規則を 2 箇所に置くと、向こうが変わったときに片方だけ古くなる**（§5）。
 *
 * **弾かれたことは、弾かれたと分かる形で返す。** **ただし 422 だけで決めない**
 * ——**422 は他の理由でも返る**ので、**文面まで見て、合わなければ投げる**
 * （**判定不能を「自己承認でした」に化けさせない**）。
 *
 * **検証済みのものだけを内側へ入れる**（§3）。
 */

import { z } from "zod";
import type {
  PullRequestReviewOutcome,
  PullRequestReviews,
  PullRequestReviewTarget,
} from "../../application/ports/pull-request-review";
import { repositoryUrl } from "./repository-url";

/**
 * 使う項目だけを検証する。
 *
 * **`state` まで見る。** **`event` を取り違えれば `COMMENTED` が返る**——
 * **それを「承認しました」と出すと、誰も承認していない PR が承認済みとして並ぶ。**
 */
const reviewSchema = z.object({
  id: z.number(),
  state: z.string(),
});

/**
 * **GitHub が自己承認を弾いたときの文面。**
 *
 * **状態コードだけでは決められない。** **422 は「レビューを要求できない」など
 * 他の理由でも返る**ので、**ここまで一致したときだけ自己承認と読む。**
 *
 * **合わなければ投げる**——**倒す向きはこちら**である。**承認が出ていないことは
 * どちらでも変わらず**、**違うのは押した人へ伝わる理由だけ**なので、
 * **「分からない」と言うほうが、嘘の理由より安い。**
 */
const SELF_APPROVAL_PATTERN = /can not approve your own pull request/i;

/**
 * 断られたときのエラー。
 *
 * **応答の中身を載せない**（§6「出力に何が含まれうるかで判断する」）——
 * **この要求の応答には、そのユーザーの持ち物が並ぶ。** **載せるのは状態コードだけ。**
 */
class ApproveFailed extends Error {
  constructor(status: number) {
    super(`GitHub が承認を受け付けませんでした (status ${status})`);
    this.name = "ApproveFailed";
  }
}

/**
 * **GitHub が「自分の PR は自分で承認できない」と言ったか。**
 *
 * **状態コードだけでは決められない**ので、**文面まで読む**（`SELF_APPROVAL_PATTERN`）。
 * **読めなければ「違う」へ倒す**——**呼ぶ側が投げる。**
 */
async function isSelfApprovalRejection(response: Response): Promise<boolean> {
  if (response.status !== 422) {
    return false;
  }
  const message = await response
    .json()
    .then((body: unknown) =>
      typeof body === "object" && body !== null && "message" in body
        ? String((body as { message: unknown }).message)
        : "",
    )
    .catch(() => "");
  return SELF_APPROVAL_PATTERN.test(message);
}

export type GitHubPullRequestReviewsOptions = {
  /** **差し替えるための引数であって、抽象ではない**（#64 と同じ形）。 */
  readonly fetchImpl?: typeof fetch;
};

export function createGitHubPullRequestReviews({
  fetchImpl = fetch,
}: GitHubPullRequestReviewsOptions = {}): PullRequestReviews {
  return {
    async approve(
      userAccessToken: string,
      { repository, number }: PullRequestReviewTarget,
    ): Promise<PullRequestReviewOutcome> {
      const response = await fetchImpl(`${repositoryUrl(repository)}/pulls/${number}/reviews`, {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${userAccessToken}`,
          "content-type": "application/json",
        },
        // **承認だけを送る。** **本文を付けられる口にしない**——
        // **この操作は「1 クリック Approve」**である（§1 のスコープ）。
        body: JSON.stringify({ event: "APPROVE" }),
      });

      if (!response.ok) {
        // **文面まで一致したときだけ自己承認と読む**（`isSelfApprovalRejection`）
        if (await isSelfApprovalRejection(response)) {
          return { kind: "self-approval" };
        }
        throw new ApproveFailed(response.status);
      }

      const parsed = reviewSchema.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) {
        throw new ApproveFailed(response.status);
      }
      if (parsed.data.state !== "APPROVED") {
        // **承認になっていないものを「承認しました」と言わない**
        throw new ApproveFailed(response.status);
      }
      return { kind: "approved" };
    },
  };
}
