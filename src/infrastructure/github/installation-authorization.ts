/**
 * installation token を持ち回して、`authorization` header を作る。
 *
 * **3 つ目の写しが出たので、ここへまとめた**（`AGENTS.md` §5「重複は 3 回目に
 * 抽象化する」。**`github-change-summary-source` の冒頭がそう書いていた**）
 * ——**PR 一覧・変更の要約・issue 一覧が、同じ 10 行を持っていた。**
 *
 * **合図は任意である。** **期限を掛ける口（`ChangeSummarySource`）と、掛けない口
 * （`PullRequestSource` の一覧）がある**——**掛けない側にまで期限を作らない。**
 */

import type { AppCredentials } from "./app-credentials";
import type { InstallationToken } from "./installation-token";
import { needsRefresh, requestInstallationToken } from "./installation-token";
import type { GitHubRepository } from "./repository-installation";
import { resolveRepositoryInstallation } from "./repository-installation";

export type InstallationAuthorizationOptions = {
  readonly credentials: AppCredentials;
  /** **設定に埋めない**（`AGENTS.md` §1）。選ぶのは合成ルートの仕事である。 */
  readonly repository: GitHubRepository;
  readonly fetchImpl: typeof fetch;
  readonly now: () => Date;
};

/**
 * `authorization` header を返す手続き。
 *
 * **token は呼び出しをまたいで持ち回る**——**1 要求ごとに取り直すと、
 * 盤面を出すだけで往復が本数ぶん増える。**
 */
export function createInstallationAuthorization({
  credentials,
  repository,
  fetchImpl,
  now,
}: InstallationAuthorizationOptions): (signal?: AbortSignal) => Promise<string> {
  let cached: InstallationToken | undefined;

  // **認証の往復にも合図を届ける。** ここが素通しだと、**呼んだ側が縮退したあとも
  // installation の解決と token の発行だけが走り続ける**——**止まるのは呼んだ側だけ**になる。
  return async function authorization(signal?: AbortSignal): Promise<string> {
    if (cached === undefined || needsRefresh(cached, now())) {
      const installationId = await resolveRepositoryInstallation({
        credentials,
        repository,
        now: now(),
        fetchImpl,
        signal,
      });
      cached = await requestInstallationToken(
        credentials,
        installationId,
        now(),
        fetchImpl,
        signal,
      );
    }
    return `Bearer ${cached.token}`;
  };
}
