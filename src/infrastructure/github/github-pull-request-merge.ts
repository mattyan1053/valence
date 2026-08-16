/**
 * `PullRequestMerges` の GitHub 実装（#331）。
 *
 * **押した人のトークンで行う**（`AGENTS.md` §6）。**installation トークンで
 * 代用しない**——**あれで実行すると、保護ルールの「マージできる人」を迂回できる**
 * （**#330 で人が決めた条件と同じ形**）。
 *
 * **マージできない理由を、こちらで数え直さない。** **GitHub が断ったことだけを
 * 受け取る**——**コンフリクト・必須チェック・保護ルールの規則を写すと、
 * 写した側が古くなる**（§5）。
 *
 * **断られたのか、届かなかったのかは分ける。** **通信や権限の失敗を
 * 「まだマージできません」と伝えると、押した人は待てば直ると思う。**
 *
 * **検証済みのものだけを内側へ入れる**（§3）。
 */

import { z } from "zod";
import type {
  PullRequestMergeOutcome,
  PullRequestMerges,
  PullRequestMergeTarget,
} from "../../application/ports/pull-request-merge";

const API_ORIGIN = "https://api.github.com";

/**
 * **squash でマージする。**
 *
 * **方法を選ばせない**（#331 の「やらないこと」）——**設定項目を先回りで作らない**
 * （§5 の YAGNI）。
 */
const MERGE_METHOD = "squash";

/**
 * 使う項目だけを検証する。
 *
 * **`merged` まで見る。** **GitHub は `merged: false` を 200 で返すことがある**
 * ——**それを「マージしました」と出すと、入っていない PR が入った顔で並ぶ。**
 */
const mergeSchema = z.object({
  merged: z.boolean(),
});

/**
 * **GitHub が「いまはマージできない」と断ったときの状態コード。**
 *
 * - **405** — 整っていない（コンフリクト / 必須チェック / 保護ルール）
 * - **409** — head が動いた（**押している間に別の commit が入った**）
 *
 * **どちらも、押した人が次に取る行動は同じ**（**GitHub で PR を見に行く**）ので、
 * **分けない**——**分けようとすると、こちらが規則を写すことになる。**
 */
const NOT_MERGEABLE_STATUSES = new Set([405, 409]);

/**
 * 断られたときのエラー。
 *
 * **応答の中身を載せない**（§6）——**載せるのは状態コードだけ。**
 */
class MergeFailed extends Error {
  constructor(status: number) {
    super(`GitHub がマージを受け付けませんでした (status ${status})`);
    this.name = "MergeFailed";
  }
}

export type GitHubPullRequestMergesOptions = {
  /** **差し替えるための引数であって、抽象ではない**（#64 と同じ形）。 */
  readonly fetchImpl?: typeof fetch;
};

export function createGitHubPullRequestMerges({
  fetchImpl = fetch,
}: GitHubPullRequestMergesOptions = {}): PullRequestMerges {
  return {
    async merge(
      userAccessToken: string,
      { repository, number }: PullRequestMergeTarget,
    ): Promise<PullRequestMergeOutcome> {
      const response = await fetchImpl(
        `${API_ORIGIN}/repos/${repository.owner}/${repository.name}/pulls/${number}/merge`,
        {
          method: "PUT",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${userAccessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ merge_method: MERGE_METHOD }),
        },
      );

      if (!response.ok) {
        // **断られたのか、届かなかったのかを分ける**（上記）
        if (NOT_MERGEABLE_STATUSES.has(response.status)) {
          return { kind: "not-mergeable" };
        }
        throw new MergeFailed(response.status);
      }

      const parsed = mergeSchema.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) {
        throw new MergeFailed(response.status);
      }
      // **`merged: false` を「マージしました」と言わない**
      return parsed.data.merged ? { kind: "merged" } : { kind: "not-mergeable" };
    },
  };
}
