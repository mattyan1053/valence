/**
 * `ChangeSummarySource` の GitHub 実装。
 *
 * **PR ごとに引く。** 変更ファイルの一覧も CI の状態も、一覧の API には載らない。
 * **本数だけ往復が増える**ので、1 本あたりの回数は 3 回（詳細・ファイル・CI）に抑え、
 * ファイルのページ数にも上限を置いている。
 *
 * **1 本の失敗で全体を落とさない。** 取れたものは返し、取れなかったものは理由を残す
 * （例外にすると、**1 本の失敗で画面が真っ白になる**）。
 *
 * **token の扱いは `github-pull-request-source` と同じ形をここにも書いている。**
 * 2 回目の重複は許容する（`AGENTS.md` §5）。**3 回目に抽象化すること。**
 */

import type {
  ChangeSummaryListing,
  ChangeSummarySource,
  UnavailableChangeSummary,
} from "../../application/ports/change-summary-source";
import type { ChangeSummary } from "../../domain/triage/risk-tier";
import type { AppCredentials } from "./app-credentials";
import { toChangeSummary } from "./change-summary-mapping";
import type { InstallationToken } from "./installation-token";
import { needsRefresh, requestInstallationToken } from "./installation-token";
import type { GitHubRepository } from "./repository-installation";
import { resolveRepositoryInstallation } from "./repository-installation";

const API_ORIGIN = "https://api.github.com";

/**
 * 変更ファイルを読むページ数の上限（1 ページ 100 件）。
 *
 * **根拠は「これを超える PR は、そもそも人が読む大きさではない」**でしかない。
 * 正確な値ではないので、**超えたことが分かる形**にしてある（材料にせず理由を残す）。
 */
const MAX_FILE_PAGES = 3;

export type GitHubChangeSummarySourceOptions = {
  readonly credentials: AppCredentials;
  /** **設定に埋めない**（`AGENTS.md` §1）。選ぶのは合成ルートの仕事である。 */
  readonly repository: GitHubRepository;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
};

export function createGitHubChangeSummarySource({
  credentials,
  repository,
  fetchImpl = fetch,
  now = () => new Date(),
}: GitHubChangeSummarySourceOptions): ChangeSummarySource {
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

  /** **応答の中身を理由に載せない。** 秘密が混ざりうる（`AGENTS.md` §6）。 */
  async function readJson(url: string, header: string): Promise<unknown> {
    const response = await fetchImpl(url, {
      headers: {
        authorization: header,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub から取得できませんでした (HTTP ${response.status})`);
    }
    return { body: await response.json(), link: response.headers.get("link") };
  }

  async function readFiles(
    number: number,
    header: string,
  ): Promise<{ files: unknown[]; truncated: boolean }> {
    const files: unknown[] = [];
    for (let page = 1; page <= MAX_FILE_PAGES; page++) {
      const url = `${API_ORIGIN}/repos/${repository.owner}/${repository.name}/pulls/${number}/files?per_page=100&page=${page}`;
      const result = (await readJson(url, header)) as { body: unknown; link: string | null };
      if (!Array.isArray(result.body)) {
        throw new Error("変更ファイルの一覧を読めませんでした");
      }
      files.push(...result.body);
      // **続きが無ければそこで終わり。** 上限に当たったときだけ「見切れた」になる
      if (result.link === null || !result.link.includes('rel="next"')) {
        return { files, truncated: false };
      }
    }
    return { files, truncated: true };
  }

  async function summaryOf(number: number, header: string): Promise<ChangeSummary> {
    const base = `${API_ORIGIN}/repos/${repository.owner}/${repository.name}`;
    const detail = (await readJson(`${base}/pulls/${number}`, header)) as { body: unknown };
    const head = (detail.body as { head?: { sha?: unknown } } | null)?.head?.sha;
    if (typeof head !== "string" || head === "") {
      throw new Error("PR の head を読めませんでした");
    }
    const { files, truncated } = await readFiles(number, header);
    const checks = (await readJson(`${base}/commits/${head}/check-runs`, header)) as {
      body: unknown;
    };

    const result = toChangeSummary({
      detail: detail.body,
      files,
      filesTruncated: truncated,
      checks: checks.body,
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    return result.summary;
  }

  return {
    async listChangeSummaries(pullRequestNumbers): Promise<ChangeSummaryListing> {
      const summaries = new Map<number, ChangeSummary>();
      const unavailable: UnavailableChangeSummary[] = [];
      if (pullRequestNumbers.length === 0) {
        return { summaries, unavailable };
      }

      const header = await authorization();
      for (const number of pullRequestNumbers) {
        try {
          summaries.set(number, await summaryOf(number, header));
        } catch (error) {
          // **落とさない。** ここで投げると、1 本の失敗で全体が消える
          unavailable.push({
            pullRequestNumber: number,
            reason: error instanceof Error ? error.message : "材料を取得できませんでした",
          });
        }
      }
      return { summaries, unavailable };
    },
  };
}
