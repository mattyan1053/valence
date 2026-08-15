/**
 * `PullRequestReview` の GitHub 実装（#315）。
 *
 * **Approve は「リポジトリへの操作」**なので、**App として叩く**
 * （installation トークン。`AGENTS.md` §6）。**「押してよいか」はここに無い**——
 * **ユーザートークンで決まったあとに呼ばれる。**
 *
 * **境界で分類してから内側へ入れる。** **応答の中身をそのまま返さない**（§6）
 * ——**GitHub の文面には他人の持ち物が混ざりうる**（リポジトリ名・利用者名）。
 * **内側へ渡すのは「どの種類の断りか」だけ**で、**画面に出るのはその分類から
 * 作った文である。**
 *
 * **成功は、検証した値から決める**（§3）。**2xx を成功と読むと、GitHub が別の
 * 状態を返した日に「押したのに付いていない」が起きる**——**症状は画面に出ない。**
 *
 * **token の扱いは `github-pull-request-source` と同じ形をここにも書いている。**
 * **3 回目**なので、**次に同じものを書くときは抽象化する**（§5）。
 */

import { z } from "zod";
import type {
  PullRequestReview,
  ReviewOutcome,
  ReviewRefusal,
} from "../../application/ports/pull-request-review";
import type { AppCredentials } from "./app-credentials";
import type { InstallationToken } from "./installation-token";
import { needsRefresh, requestInstallationToken } from "./installation-token";
import type { GitHubRepository } from "./repository-installation";
import { resolveRepositoryInstallation } from "./repository-installation";

const API_ORIGIN = "https://api.github.com";

/**
 * Approve の応答。**要るのは状態だけ**——**それ以外は読まない**
 * （**読まないものは、混ざりようがない**）。
 */
const reviewResponse = z.object({ state: z.string() });

/**
 * HTTP の状態から、断りの種類へ畳む。
 *
 * **知らない状態は `unavailable` へ倒す**（#90 と同じ判断）——**成功の側を並べ、
 * それ以外は失敗へ倒す**ので、**GitHub が値を増やしても「押せた」にはならない。**
 */
function refusalFor(status: number): ReviewRefusal {
  switch (status) {
    case 403:
      // **App にその権限が無い。** 押した人には解けない
      return "not-permitted";
    case 422:
      // **GitHub が受け付けない**（自分の PR を Approve した等）
      return "not-reviewable";
    case 404:
      // **その PR が無い。** **「見えない」ではない**——**見えることは確認済み**である
      return "gone";
    default:
      return "unavailable";
  }
}

export type GitHubPullRequestReviewOptions = {
  readonly credentials: AppCredentials;
  /** **設定に埋めない**（§1）。選ぶのは合成ルートの仕事である。 */
  readonly repository: GitHubRepository;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
};

export function createGitHubPullRequestReview({
  credentials,
  repository,
  fetchImpl = fetch,
  now = () => new Date(),
}: GitHubPullRequestReviewOptions): PullRequestReview {
  let cached: InstallationToken | undefined;

  async function authorization(): Promise<string> {
    if (cached === undefined || needsRefresh(cached, now())) {
      const installationId = await resolveRepositoryInstallation({
        credentials,
        repository,
        now: now(),
        fetchImpl,
      });
      cached = await requestInstallationToken(credentials, installationId, now(), fetchImpl);
    }
    return `Bearer ${cached.token}`;
  }

  return {
    async approve(pullRequestNumber: number): Promise<ReviewOutcome> {
      let response: Response;
      try {
        response = await fetchImpl(
          `${API_ORIGIN}/repos/${repository.owner}/${repository.name}/pulls/${pullRequestNumber}/reviews`,
          {
            method: "POST",
            headers: {
              accept: "application/vnd.github+json",
              authorization: await authorization(),
              "content-type": "application/json",
            },
            body: JSON.stringify({ event: "APPROVE" }),
          },
        );
      } catch {
        // **投げたものを握りつぶさない。** **もう一度なら通りうる側**である
        return { kind: "refused", reason: "unavailable" };
      }

      if (!response.ok) {
        return { kind: "refused", reason: refusalFor(response.status) };
      }

      const parsed = reviewResponse.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success || parsed.data.state !== "APPROVED") {
        // **2xx でも、付いたと言い切らない。** **読めない応答も同じ扱い**
        // ——**「押したのに付いていない」を成功として返さない**
        return { kind: "refused", reason: "unavailable" };
      }
      return { kind: "approved" };
    },
  };
}
