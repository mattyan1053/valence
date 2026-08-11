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
import { toChangeSummary, toHeadSha } from "./change-summary-mapping";
import type { InstallationToken } from "./installation-token";
import { needsRefresh, requestInstallationToken } from "./installation-token";
import type { GitHubRepository } from "./repository-installation";
import { resolveRepositoryInstallation } from "./repository-installation";

const API_ORIGIN = "https://api.github.com";

/**
 * 1 つの一覧で読むページ数の上限（1 ページ 100 件）。
 *
 * **根拠は「これを超える PR は、そもそも人が読む大きさではない」**でしかない。
 * 正確な値ではないので、**超えたことが分かる形**にしてある（材料にせず理由を残す）。
 *
 * **どの一覧にも同じ上限を当てる。** ファイルだけを手当てして CI の結果を 1 ページで
 * 済ませていたため、**「30 件しか見ていないのに passing」**になっていた（#117 のレビュー）。
 */
const MAX_PAGES = 3;

/**
 * 打ち切られたか。
 *
 * **その都度読む。** `signal?.aborted` を式のまま書くと、型検査が
 * **「1 度見たら変わらない」**と絞り込む——**待っている間に変わる**のがこの値の役目で、
 * **変わりうることを関数で表す**。
 */
function abandoned(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

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
  // **合図は最後まで運ぶ。** 途中で落とすと、**中断したのに往復だけ続く**
  async function readJson(url: string, header: string, signal?: AbortSignal): Promise<unknown> {
    const response = await fetchImpl(url, {
      signal,
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

  /**
   * ページを繋いで読む。**続きが無ければそこで終わり**で、
   * **上限に当たったときだけ「見切れた」**になる。
   */
  async function readPages(
    path: string,
    pick: (body: unknown) => unknown[] | undefined,
    header: string,
    signal?: AbortSignal,
  ): Promise<{ items: unknown[]; truncated: boolean }> {
    const items: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${API_ORIGIN}/repos/${repository.owner}/${repository.name}${path}?per_page=100&page=${page}`;
      const result = (await readJson(url, header, signal)) as {
        body: unknown;
        link: string | null;
      };
      const chunk = pick(result.body);
      if (chunk === undefined) {
        throw new Error("一覧を読めませんでした");
      }
      items.push(...chunk);
      if (result.link === null || !result.link.includes('rel="next"')) {
        return { items, truncated: false };
      }
    }
    return { items, truncated: true };
  }

  /** **見切れたら材料にしない。** 「見ていない」を「通っている」と読まないため。 */
  async function readAll(
    path: string,
    pick: (body: unknown) => unknown[] | undefined,
    header: string,
    what: string,
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    const { items, truncated } = await readPages(path, pick, header, signal);
    if (truncated) {
      throw new Error(`${what}が多すぎて最後まで見切れませんでした`);
    }
    return items;
  }

  async function summaryOf(
    number: number,
    header: string,
    signal?: AbortSignal,
  ): Promise<ChangeSummary> {
    const base = `${API_ORIGIN}/repos/${repository.owner}/${repository.name}`;
    const detail = (await readJson(`${base}/pulls/${number}`, header, signal)) as { body: unknown };
    // **検証してから URL へ入れる**（`AGENTS.md` §6）。素通しにすると、
    // **installation トークンを付けたまま別の endpoint を叩ける**。
    const head = toHeadSha(detail.body);
    if (head === undefined) {
      throw new Error("PR の head を読めませんでした");
    }
    const files = await readPages(
      `/pulls/${number}/files`,
      (body) => (Array.isArray(body) ? body : undefined),
      header,
      signal,
    );
    // **CI の結果も最後まで読む。** ファイルだけ手当てして片方を 1 ページで済ませると、
    // **見ていない run が「通っている」に化ける**。
    // **Checks API と Commit Status の両方を見る**——**道具立てを前提にしない**
    // （`AGENTS.md` §1）。Commit Status だけを登録する CI があり、
    // 片方しか見ないと、そのリポジトリでは全 PR が永久に `pending` になる。
    const checkRuns = await readAll(
      `/commits/${head}/check-runs`,
      (body) => (body as { check_runs?: unknown })?.check_runs as unknown[] | undefined,
      header,
      "CI の結果",
      signal,
    );
    const statuses = await readAll(
      `/commits/${head}/status`,
      (body) => (body as { statuses?: unknown })?.statuses as unknown[] | undefined,
      header,
      "CI の状態",
      signal,
    );

    // **3 回の取得は別々の瞬間を見ている。** 間に push が入ると、
    // **古い版の件数と CI に、新しい版のパス**が混ざり、
    // **未検証の新しい版に「読まずにマージしてよい」と出る**。
    // **取り直さない**——また間に push が入りうるので終わらない。材料にしなければ、
    // 行は残ったまま次の周回で埋まる（#112）。
    const again = (await readJson(`${base}/pulls/${number}`, header, signal)) as { body: unknown };
    if (toHeadSha(again.body) !== head) {
      throw new Error("取得の途中で PR が更新されました（別々の版が混ざるため材料にしません）");
    }

    const result = toChangeSummary({
      detail: detail.body,
      files: files.items,
      filesTruncated: files.truncated,
      checks: { check_runs: checkRuns },
      statuses: { statuses },
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    return result.summary;
  }

  /** 打ち切られたぶん。**「読めなかった」と同じ場所に出るが、同じものではない。** */
  function giveUp(numbers: readonly number[]): UnavailableChangeSummary[] {
    return numbers.map((pullRequestNumber) => ({
      pullRequestNumber,
      kind: "timedout" as const,
      reason: "期限までに材料が返りませんでした",
    }));
  }

  /**
   * 1 本ぶんの結果。**投げずに返す**ので、集める側に try/catch が入らない
   * （入れ子が増えると、**読む人も検査器も追えなくなる**）。
   */
  type Attempt =
    | { readonly ok: true; readonly summary: ChangeSummary }
    | { readonly ok: false; readonly reason: string };

  async function attempt(
    number: number,
    header: string,
    signal: AbortSignal | undefined,
  ): Promise<Attempt> {
    try {
      return { ok: true, summary: await summaryOf(number, header, signal) };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : "材料を取得できませんでした",
      };
    }
  }

  /**
   * 1 本ずつ集める。**合図を見たら、取れたぶんを持って返る。**
   *
   * 最後まで回すと、**呼んだ側が縮退したあとも往復が続く**——**止まるのは呼んだ側だけ**
   * になる。**残りは打ち切りとして残す**ので、**「読めなかった」とは混ざらない。**
   */
  async function collectSummaries(
    numbers: readonly number[],
    header: string,
    signal: AbortSignal | undefined,
  ): Promise<ChangeSummaryListing> {
    const summaries = new Map<number, ChangeSummary>();
    const unavailable: UnavailableChangeSummary[] = [];
    const stopAt = (index: number): ChangeSummaryListing => ({
      summaries,
      unavailable: [...unavailable, ...giveUp(numbers.slice(index))],
    });

    for (const [index, number] of numbers.entries()) {
      if (abandoned(signal)) {
        return stopAt(index);
      }
      const result = await attempt(number, header, signal);
      if (result.ok) {
        summaries.set(number, result.summary);
        continue;
      }
      // **取り消しの跡を「読めなかった」にしない。** fetch は中断されると投げる
      if (abandoned(signal)) {
        return stopAt(index);
      }
      // **落とさない。** ここで投げると、1 本の失敗で全体が消える
      unavailable.push({ pullRequestNumber: number, kind: "unreadable", reason: result.reason });
    }
    return { summaries, unavailable };
  }

  return {
    async listChangeSummaries(pullRequestNumbers, request): Promise<ChangeSummaryListing> {
      if (pullRequestNumbers.length === 0) {
        return { summaries: new Map(), unavailable: [] };
      }
      const header = await authorization();
      return collectSummaries(pullRequestNumbers, header, request?.signal);
    },
  };
}
