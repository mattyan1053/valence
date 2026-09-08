/**
 * `PullRequestSource` の GitHub 実装。
 *
 * **境界の仕事を 1 本に繋ぐ。** installation token を取り、PR 一覧を最後のページまで
 * 読み、`toPullRequestRefs` でドメイン型へ移す。**検証済みのものだけを内側へ渡す**
 * （port の契約）。
 *
 * **合流の状況だけは GraphQL で訊く**（#629）。**REST の PR 一覧は `mergeable` を
 * 返さない**——**あるのは 1 件ずつの `GET /pulls/{number}` だけ**なので、
 * **REST で揃えると PR の本数ぶん往復することになる。**
 *
 * **2 つの口を同時に叩く。** **順に待つと、盤面の期限（#573）をそのぶん食う**
 * ——**一覧の取得と合流の状況に、互いの結果は要らない。**
 *
 * **合流の状況にだけ期限を掛ける** (#644 のレビュー)。**落ちるのと遅いのは別の経路**
 * である（#119 / #120）——**`catch` は reject しか拾わない**ので、**応答待ちのまま
 * 返らないと、一覧が取れていても盤面ごと出ない。** **一覧の側には掛けない**
 * ——**あれが返らなければ、そもそも出せるものが無い。**
 */

import type {
  PullRequestListing,
  PullRequestSource,
} from "../../application/ports/pull-request-source";
import type { MergeStatusReport } from "../../domain/graph/merge-readiness";
import type { AppCredentials } from "./app-credentials";
import type { InstallationToken } from "./installation-token";
import { needsRefresh, requestInstallationToken } from "./installation-token";
import { nextPageUrl } from "./link-pagination";
import type { MergeStatusPage } from "./merge-status-mapping";
import { toMergeStatusPage } from "./merge-status-mapping";
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
  /**
   * 合流の状況の取得を打ち切る合図を**作る手続き**（#644 のレビュー）。
   *
   * **作る手続きで受けるのは、数え始める位置のため**である（#316 と同じ理由）
   * ——**`AbortSignal.timeout` は作った瞬間から数え始める**ので、
   * **口を作った時点で作ると、使われるまでの時間が期限から引かれる。**
   *
   * **1 回の呼び出し全体に 1 つ**である（**ページごとではない**）——
   * **ページごとに掛けると、続きがあるぶんだけ待つ時間が伸びる。**
   */
  readonly mergeStatusDeadline?: () => AbortSignal;
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
  mergeStatusDeadline = () => AbortSignal.timeout(MERGE_STATUS_DEADLINE_MS),
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

  /** PR 一覧を、最後のページまで読む。**読み切れなければ投げる。** */
  async function readPullRequests(header: string): Promise<unknown[]> {
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
    return items;
  }

  return {
    async listPullRequests(): Promise<PullRequestListing> {
      const header = await authorization();
      // **同時に叩く**——**互いの結果は要らない**ので、**順に待つ理由が無い**
      const [items, mergeStatuses] = await Promise.all([
        readPullRequests(header),
        // **合図はここで作る**（#316 と同じ理由）——**token を取るぶんを期限から引かない**
        readMergeStatuses(fetchImpl, repository, header, mergeStatusDeadline()),
      ]);
      return { ...toPullRequestRefs(items), mergeStatuses };
    },
  };
}

const API_ORIGIN = "https://api.github.com";

/**
 * 合流の状況の取得を打ち切るまで（#644 のレビュー）。
 *
 * **1 要求で 100 件**（`PAGE_SIZE`）なので、**承認の状態（`APPROVALS_DEADLINE_MS`）と
 * 同じ桁**にしてある。**打ち切られた PR は地図に入らず、行は「まだ分かりません」**と出る
 * ——**「マージできる」には倒れない**ので、**足りなければ画面で分かる。**
 *
 * **既定を持つ。** **渡し忘れが「期限なし」に倒れると、遅い日に盤面ごと出なくなる**
 * ——**#644 のレビューが指したのは、その状態である。**
 */
const MERGE_STATUS_DEADLINE_MS = 5_000;

/** 1 度に読む件数。**GraphQL の上限は 100**（REST の一覧と同じ）。 */
const PAGE_SIZE = 100;

/**
 * 開いている PR と、その合流の状況。
 *
 * **`states: OPEN` で絞る**（REST の一覧と同じ）——**盤面に並ぶのは開いている PR**
 * である。**一覧から落ちたものは地図に入らず、「まだ分かりません」になる。**
 */
const MERGE_STATUS_QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: ${PAGE_SIZE}, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { number mergeable mergeStateStatus }
    }
  }
}`;

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

/**
 * 合流の状況を 1 ページ読む。**断られたなら `undefined`。**
 *
 * **断られたなら、本文は読まない**（#64 と同じ形）——**状態コードを見ずに本文だけを
 * 読むと、エラーの本文がそれらしい形をしていたときに材料として通る。**
 */
async function readMergeStatusPage(
  fetchImpl: typeof fetch,
  repository: GitHubRepository,
  header: string,
  cursor: string | undefined,
  deadline: AbortSignal,
): Promise<MergeStatusPage | undefined> {
  const response = await fetchImpl(`${API_ORIGIN}/graphql`, {
    method: "POST",
    headers: {
      authorization: header,
      // **`mergeStateStatus` は preview のまま**である（GitHub の文書が
      // このヘッダを要求している）——**要らない日が来ても害は無い**が、
      // **無い前提に寄せると、向こうが厳しくなった日に黙って消える**
      accept: "application/vnd.github.merge-info-preview+json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: MERGE_STATUS_QUERY,
      // **どのリポジトリかは要求ごとに決まる**（設定に固定しない。§1）
      variables: { owner: repository.owner, name: repository.name, cursor: cursor ?? null },
    }),
    // **合図を口まで通す**（#346 のレビューと同じ）——**先に返すだけでは、
    // 走っている要求は走り続ける。** **ここは `fetch` を直に呼ぶ側**なので、
    // **渡せば止まる**（**行儀を疑う相手が居ない**）
    signal: deadline,
  });
  return response.ok ? toMergeStatusPage(safeJson(await response.text())) : undefined;
}

/**
 * 合流の状況を、最後のページまで読む。
 *
 * **落ちても投げない**（`collectChanges` と同じ判断）——**依存グラフだけでも
 * 交通整理の役に立つ**ので、**合流の状況のために盤面ごと落とさない。**
 *
 * **黙って「問題なし」にはならない。** **返らなかった PR は地図に入らず**、
 * **`mergeReadinessOf` がそれを `unknown` へ倒す**——**「読めなかった」が
 * 「マージできる」に化けない。**
 *
 * **途中まで読めたぶんは返す。** **残りは地図に無いまま**なので、
 * **その行は「まだ分かりません」と出る**（**「マージできる」ではない**）。
 *
 * **打ち切りも同じ扱いである** (#644 のレビュー)。**合図が鳴れば `fetch` は reject する**
 * ので、**遅い日も、落ちた日と同じ経路で縮退する。**
 */
async function readMergeStatuses(
  fetchImpl: typeof fetch,
  repository: GitHubRepository,
  header: string,
  deadline: AbortSignal,
): Promise<ReadonlyMap<number, MergeStatusReport>> {
  const statuses = new Map<number, MergeStatusReport>();
  // **読めたぶんはその場で入る**ので、**打ち切っても、途中までは残る**
  const reading = collectMergeStatuses(fetchImpl, repository, header, deadline, statuses)
    // **落ちたぶんは、ここで飲む**——**投げると盤面ごと落ちる**（上のコメント）。
    // **競争に負けたあとで落ちることもある**ので、**受け手はここに要る**
    .catch(() => undefined);
  // **口の行儀に頼らない**（#346 のレビュー。#644 のレビュー）——**合図を渡しても、
  // 受け取らない実装・無視する実装はありうる**（`fetchImpl` は差し替えられる引数である）。
  // **待つのをやめる側と、取り消しを伝える側の両方**が要る
  await Promise.race([reading, abortion(deadline)]);
  return statuses;
}

/** 合流の状況を、最後のページまで `statuses` へ入れる。**落ちたら投げる。** */
async function collectMergeStatuses(
  fetchImpl: typeof fetch,
  repository: GitHubRepository,
  header: string,
  deadline: AbortSignal,
  statuses: Map<number, MergeStatusReport>,
): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const page = await readMergeStatusPage(fetchImpl, repository, header, cursor, deadline);
    if (page === undefined) {
      return;
    }
    for (const [number, status] of page.statuses) {
      statuses.set(number, status);
    }
    if (page.nextCursor === undefined) {
      return;
    }
    cursor = page.nextCursor;
  }
}

/** 合図が鳴るまで返らない約束（`view-repository-board.ts` と同じ形）。 */
function abortion(deadline: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (deadline.aborted) {
      resolve();
      return;
    }
    deadline.addEventListener("abort", () => resolve(), { once: true });
  });
}
