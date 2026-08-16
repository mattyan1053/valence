/**
 * `PullRequestSource` の GitHub 実装。
 *
 * **境界の仕事を 1 本に繋ぐ。** installation token を取り、PR 一覧を最後のページまで
 * 読み、`toPullRequestRefs` でドメイン型へ移す。**検証済みのものだけを内側へ渡す**
 * （port の契約）。
 */

import type {
  PullRequestListing,
  PullRequestSource,
} from "../../application/ports/pull-request-source";
import type { AppCredentials } from "./app-credentials";
import type { InstallationToken } from "./installation-token";
import { needsRefresh, requestInstallationToken } from "./installation-token";
import { nextPageUrl } from "./link-pagination";
import { toPullRequestRefs } from "./pull-request-mapping";
import type { GitHubRepository } from "./repository-installation";
import { resolveRepositoryInstallation } from "./repository-installation";
import { repositoryUrl } from "./repository-url";

export type GitHubPullRequestSourceOptions = {
  readonly credentials: AppCredentials;
  /**
   * どのリポジトリの一覧を取るか。**引数で受ける**（設定に埋めない）。
   *
   * **設定へ書いた時点で 1 テナントしか扱えない**（`AGENTS.md` §1）。
   * 選ぶのは合成ルートの仕事で、ここは渡されたものを見るだけである。
   */
  readonly repository: GitHubRepository;
  /** **差し替えるための引数であって、抽象ではない**（#64 と同じ形）。 */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
};

/**
 * 一覧を取ってくる口を作る。
 *
 * **token は使い回す。** 1 時間有効なものを毎回取り直すと、GitHub 側の制限に
 * 無駄に当たる。取り直すかどうかの判断は `needsRefresh`（#64）に任せる。
 */
export function createGitHubPullRequestSource({
  credentials,
  repository,
  fetchImpl = fetch,
  now = () => new Date(),
}: GitHubPullRequestSourceOptions): PullRequestSource {
  let cached: InstallationToken | undefined;

  /**
   * **installation は実行時に解決する**（`AGENTS.md` §1）。設定に置くと
   * **1 つのアカウントしか扱えない**。token は installation ごとのものなので、
   * 取り直すときは解決からやり直す。
   */
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
    async listPullRequests(): Promise<PullRequestListing> {
      const header = await authorization();
      const items: unknown[] = [];

      let url: string | undefined = firstPage(repository);
      while (url !== undefined) {
        const response = await fetchImpl(url, {
          headers: {
            authorization: header,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
          },
        });
        if (!response.ok) {
          throw listRequestError(response.status);
        }
        const page: unknown = safeJson(await response.text());
        if (!Array.isArray(page)) {
          throw listResponseError(response.status);
        }
        items.push(...page);
        url = nextPageUrl(response.headers.get("link"), "PR 一覧");
      }
      return toPullRequestRefs(items);
    },
  };
}

/**
 * **open な PR だけを取る。**
 *
 * 依存グラフは「これからマージする PR の交通整理」なので、閉じた PR は要らない。
 * 含めると、**閉じた PR の head と一致する base から過去の依存が復活し**、
 * 同じ head を持つ PR も増えて（`buildDependencyEdges` の曖昧判定）辺が消える。
 *
 * 1 ページ 100 件は GitHub の上限。**ページ数を減らすだけで、読み切る責務は変わらない。**
 */
function firstPage(repository: GitHubRepository): string {
  return `${repositoryUrl(repository)}/pulls?state=open&per_page=100`;
}

/**
 * **応答の中身を載せない。** ここでも #64 と同じ扱いにする。
 * 途中のページで失敗したときも投げる——**読み切れなかったものを成功にしない**。
 */
function listRequestError(status: number): Error {
  return new Error(`PR 一覧を取得できませんでした (HTTP ${status})`);
}

/** **「断られた」と「読めなかった」を分ける**（#64 と同じ理由）。 */
function listResponseError(status: number): Error {
  return new Error(`PR 一覧の応答を読めませんでした (HTTP ${status})`);
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
