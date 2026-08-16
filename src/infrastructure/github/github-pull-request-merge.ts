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
 * **試す順**（#331 のレビュー）。
 *
 * **方法を固定しない。** **このリポジトリは squash と決めてある**が、
 * **この製品は複数のインストール先を跨ぐ**（`AGENTS.md` §1）——
 * **squash を無効にしているリポジトリでは、書き込み権限があってマージ可能でも
 * すべて 405 になり、この機能を 1 度も使えない。** **しかも 405 を
 * `not-mergeable` に丸めるので、画面は「コンフリクトか必須チェックの問題」だと言う**
 * ——**事実でないことを伝えることになる。**
 *
 * **どれを優先するかは決めてよい**ので、**squash を第一候補にする**
 * （**このリポジトリの慣行**。`.claude/rules/git-workflow.md`）。
 * **選ばせるための設定項目は作らない**（§5 の YAGNI）——**要求ごとに解決するだけ**である。
 */
const MERGE_METHOD_PREFERENCE = ["squash", "merge", "rebase"] as const;

/**
 * そのリポジトリで許可されている方式。**要求ごとに引く**（§1）。
 *
 * **使う項目だけを検証する。** **欠けていたら読めなかったことにする**
 * ——**「許可されていない」と「読めなかった」を混ぜない。**
 */
const repositorySchema = z.object({
  allow_squash_merge: z.boolean(),
  allow_merge_commit: z.boolean(),
  allow_rebase_merge: z.boolean(),
});

/**
 * 使う項目だけを検証する。
 *
 * **`merged` まで見る。** **GitHub は `merged: false` を 200 で返すことがある**
 * ——**それを「マージしました」と出すと、入っていない PR が入った顔で並ぶ。**
 */
const mergeSchema = z.object({
  merged: z.boolean(),
});

/** 応答から、試す順で最初に許可されている方式を選ぶ。 */
function allowedMethod(
  allowed: z.infer<typeof repositorySchema>,
): (typeof MERGE_METHOD_PREFERENCE)[number] | undefined {
  const enabled = {
    squash: allowed.allow_squash_merge,
    merge: allowed.allow_merge_commit,
    rebase: allowed.allow_rebase_merge,
  };
  return MERGE_METHOD_PREFERENCE.find((method) => enabled[method]);
}

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
  /**
   * **そのリポジトリで許可されている方式を引く。**
   *
   * **読めなければ投げる**——**「許可されていない」と混ぜない。**
   * **ユーザートークンで引く**（§6。**installation で代用しない**）。
   */
  async function methodFor(
    userAccessToken: string,
    repository: PullRequestMergeTarget["repository"],
  ): Promise<(typeof MERGE_METHOD_PREFERENCE)[number] | undefined> {
    const response = await fetchImpl(`${API_ORIGIN}/repos/${repository.owner}/${repository.name}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${userAccessToken}`,
      },
    });
    if (!response.ok) {
      throw new MergeFailed(response.status);
    }
    const parsed = repositorySchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
      throw new MergeFailed(response.status);
    }
    return allowedMethod(parsed.data);
  }

  return {
    async merge(
      userAccessToken: string,
      { repository, number, headSha }: PullRequestMergeTarget,
    ): Promise<PullRequestMergeOutcome> {
      const method = await methodFor(userAccessToken, repository);
      if (method === undefined) {
        // **どの方式も許可されていない。** **押した人が次にすることは
        // 「GitHub で見る」**なので、`not-mergeable` へ倒す——**故障ではない。**
        return { kind: "not-mergeable" };
      }

      const response = await fetchImpl(
        `${API_ORIGIN}/repos/${repository.owner}/${repository.name}/pulls/${number}/merge`,
        {
          method: "PUT",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${userAccessToken}`,
            "content-type": "application/json",
          },
          // **`sha` を載せる**（#331 のレビュー）——**盤面を出してから押すまでに
          // push された変更を、確かめないままマージしない。**
          // **載せて初めて、GitHub が head の食い違いを 409 で返す**
          // （**載せなければ、下の 409 の分岐は原則として通らない**）。
          body: JSON.stringify({ merge_method: method, sha: headSha }),
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
