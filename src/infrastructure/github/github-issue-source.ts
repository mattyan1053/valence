/**
 * `IssueSource` の GitHub 実装（#633）。
 *
 * **境界の仕事を 1 本に繋ぐ。** installation token を取り、issue 一覧を最後のページまで
 * 読み、`toIssueListing` でドメイン型へ移す。**検証済みのものだけを内側へ渡す**
 * （port の契約）。
 *
 * **PR の口と分けてある。** **`GET /issues` は PR も返す**が、**落とすのは
 * `toIssueListing`** で、**ここは通信だけを持つ。**
 */

import type { IssueListing, IssueSource } from "../../application/ports/issue-source";
import type { AppCredentials } from "./app-credentials";
import { createInstallationAuthorization } from "./installation-authorization";
import { toIssueListing } from "./issue-mapping";
import { nextPageUrl } from "./link-pagination";
import type { GitHubRepository } from "./repository-installation";
import { repositoryUrl } from "./repository-url";

export type GitHubIssueSourceOptions = {
  readonly credentials: AppCredentials;
  /** **設定に埋めない**（`AGENTS.md` §1）。選ぶのは合成ルートの仕事である。 */
  readonly repository: GitHubRepository;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
};

/** **応答の中身をエラーに載せない**（`AGENTS.md` §6）。秘密が混ざりうる。 */
function listRequestError(status: number): Error {
  return new Error(`GitHub から issue 一覧を取得できませんでした (HTTP ${status})`);
}

function listResponseError(): Error {
  return new Error("GitHub の issue 一覧を読み取れませんでした");
}

export function createGitHubIssueSource({
  credentials,
  repository,
  fetchImpl = fetch,
  now = () => new Date(),
}: GitHubIssueSourceOptions): IssueSource {
  const authorization = createInstallationAuthorization({
    credentials,
    repository,
    fetchImpl,
    now,
  });

  return {
    async listIssues(): Promise<IssueListing> {
      const header = await authorization();
      const items: unknown[] = [];

      let url: string | undefined = `${repositoryUrl(repository)}/issues?state=open&per_page=100`;
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
        const page: unknown = await response.json().catch(() => undefined);
        // **投げる。** **空の一覧にすると「取得できなかった」が「issue が 0 件」に化ける**
        if (!Array.isArray(page)) {
          throw listResponseError();
        }
        items.push(...page);
        url = nextPageUrl(response.headers.get("link"), "issue 一覧");
      }
      return toIssueListing(items);
    },
  };
}
