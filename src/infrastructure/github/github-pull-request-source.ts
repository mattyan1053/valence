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
  ListedPullRequests,
  PullRequestListing,
  PullRequestSource,
} from "../../application/ports/pull-request-source";
import type { PullRequestRef } from "../../domain/graph/dependency-graph";
import type { MergeStatusReport } from "../../domain/graph/merge-readiness";
import type { ReviewOpinion } from "../../domain/triage/ball";
import type { AppCredentials } from "./app-credentials";
import type { InstallationToken } from "./installation-token";
import { needsRefresh, requestInstallationToken } from "./installation-token";
import { nextPageUrl } from "./link-pagination";
import type { MergeStatusPage } from "./merge-status-mapping";
import { toBehindBy, toMergeStatusPage } from "./merge-status-mapping";
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
  /**
   * **base にどれだけ遅れているか**の取得を打ち切る合図を**作る手続き**（#639）。
   *
   * **合流の状況とは別に持つ。** **あちらは 1 要求で 100 件**だが、**こちらは
   * PR ごとに 1 要求**である（**GraphQL の引数は node ごとに変えられない**）
   * ——**同じ期限に相乗りさせると、本数の多い盤面で合流の状況まで巻き添えになる。**
   *
   * **作る手続きで受けるのは、数え始める位置のため**である（`mergeStatusDeadline` と同じ）。
   */
  readonly baseLagDeadline?: () => AbortSignal;
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
  baseLagDeadline = () => AbortSignal.timeout(BASE_LAG_DEADLINE_MS),
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
    /**
     * **依存を決めるぶんだけ**（#650 のレビュー）。**一覧の応答だけで作る**ので、
     * **PR の本数で往復が増えない**——**押す経路はこちらを使う。**
     */
    async listPullRequestRefs(): Promise<ListedPullRequests> {
      return toPullRequestRefs(await readPullRequests(await authorization()));
    },

    async listPullRequests(): Promise<PullRequestListing> {
      const header = await authorization();
      // **同時に叩く**——**互いの結果は要らない**ので、**順に待つ理由が無い**
      const [items, board] = await Promise.all([
        readPullRequests(header),
        // **合図はここで作る**（#316 と同じ理由）——**token を取るぶんを期限から引かない**
        readMergeStatuses(fetchImpl, repository, header, mergeStatusDeadline()),
      ]);
      const { statuses: mergeStatuses, opinions } = board;
      const refs = toPullRequestRefs(items);
      // **一覧が要る**ので、ここから先は順に走る（#639）——**base の枝と head の
      // commit が分かって初めて、どれとどれを比べるかが決まる。**
      await addBaseLags({
        fetchImpl,
        repository,
        header,
        refs,
        mergeStatuses,
        deadline: baseLagDeadline(),
      });
      return { ...refs, mergeStatuses, opinions };
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

/**
 * base の遅れの取得を打ち切るまで（#639）。
 *
 * **PR ごとに 1 要求**なので、**合流の状況より短く見積もらない**——**打ち切られた PR は
 * 数を持たず、画面は何も言わない**（**「遅れ 0」には倒れない**）。
 */
const BASE_LAG_DEADLINE_MS = 5_000;

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
      nodes {
        number mergeable mergeStateStatus
        # 誰の番かを決める材料（#636）。同じ node にあるので往復は増えない
        headRefOid
        # 意見を持たないレビューも数える（#636 の罠）。提出した人は
        # requested_reviewers から消えるので、依頼の有無だけでは放置と区別できない
        reviews { totalCount }
        latestOpinionatedReviews(first: ${PAGE_SIZE}) {
          pageInfo { hasNextPage }
          nodes { state commit { oid } }
        }
      }
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
  // **書ける地図を返す** (#639)。**base の遅れを、そのまま同じ地図へ足す**
  // ——**別の地図にすると、port から画面まで運ぶ道が 1 本増える。**
): Promise<BoardStatuses> {
  const statuses = new Map<number, MergeStatusReport>();
  const opinions = new Map<number, ReviewOpinion>();
  // **読めたぶんはその場で入る**ので、**打ち切っても、途中までは残る**
  const reading = collectMergeStatuses(fetchImpl, repository, header, deadline, {
    statuses,
    opinions,
  })
    // **落ちたぶんは、ここで飲む**——**投げると盤面ごと落ちる**（上のコメント）。
    // **競争に負けたあとで落ちることもある**ので、**受け手はここに要る**
    .catch(() => undefined);
  // **口の行儀に頼らない**（#346 のレビュー。#644 のレビュー）——**合図を渡しても、
  // 受け取らない実装・無視する実装はありうる**（`fetchImpl` は差し替えられる引数である）。
  // **待つのをやめる側と、取り消しを伝える側の両方**が要る
  await Promise.race([reading, abortion(deadline)]);
  return { statuses, opinions };
}

/**
 * **盤面が要る、PR ごとの状況**（#636）。
 *
 * **1 つの問い合わせから来る**ので、**まとめて返す**——**別々に取ると、
 * 間に main が進んだときに食い違う。**
 */
type BoardStatuses = {
  readonly statuses: Map<number, MergeStatusReport>;
  readonly opinions: Map<number, ReviewOpinion>;
};

/** 合流の状況を、最後のページまで `statuses` へ入れる。**落ちたら投げる。** */
async function collectMergeStatuses(
  fetchImpl: typeof fetch,
  repository: GitHubRepository,
  header: string,
  deadline: AbortSignal,
  into: BoardStatuses,
): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const page = await readMergeStatusPage(fetchImpl, repository, header, cursor, deadline);
    if (page === undefined) {
      return;
    }
    for (const [number, status] of page.statuses) {
      into.statuses.set(number, status);
    }
    for (const [number, opinion] of page.opinions) {
      into.opinions.set(number, opinion);
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

/**
 * **base に何コミット遅れているか**を訊く（#639）。
 *
 * **`mergeStateStatus` では数が出ない。** **`BEHIND` は「入るかどうか」**で、
 * **最新化を要求しない設定では、遅れていても返らない**（#644 のレビュー）
 * ——**compare が `behindBy` をそのまま返す。**
 *
 * **枝の名前を URL へ入れない**（`AGENTS.md` §6）。**GraphQL の変数で渡す**ので、
 * **`..` や `/` を含む枝名でも、別の endpoint を叩く形にはならない**
 * （**REST の compare は `base...head` をパスへ入れる**）。
 *
 * **head は commit で指す。** **見せたものに固定する**（#331 と同じ向き）——
 * **枝の名前で聞くと、盤面を出してから push されたぶんまで数に入る。**
 *
 * **`qualifiedName` は短い名前でよい。** **`refs/heads/` を付けても答えは同じ**である
 * ——**測った**（2026-09-08、この PR の head に対して `main` と `refs/heads/main` の
 * どちらでも `behindBy 1 / status DIVERGED`）。**`Repository.ref` は完全修飾を先に探し、
 * 無ければ短い名前へ落とす**ので、**`ref` が `null` になる経路はここでは無い。**
 * **付け足す「修正」を入れなくてよい**（#650 のレビューで 1 度疑われた）。
 *
 * **base は枝の名前で聞く。** **PR が持っている `base.sha` は使えない**
 * ——**あれは base の枝の先端を追わない。** **実測（2026-09-08、このリポジトリ）:
 * PR #647 の `base.sha` は `a6b8f8f` のままで、その間に main は 2 回進んだ**
 * （`261db55` → `c6ec166`）。**`base.sha` で比べると遅れは必ず 0 になり**、
 * **黙って「遅れていません」と出る**（`AGENTS.md` §5。**このリポジトリが繰り返し
 * 塞いでいる形**）。
 */
const BASE_LAG_QUERY = `query($owner: String!, $name: String!, $base: String!, $head: String!) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $base) { compare(headRef: $head) { behindBy } }
  }
}`;

/** 1 本ぶん訊く。**断られたなら `undefined`**（**「遅れ 0」ではない**）。 */
async function readBaseLag(
  fetchImpl: typeof fetch,
  repository: GitHubRepository,
  header: string,
  base: string,
  head: string,
  deadline: AbortSignal,
): Promise<number | undefined> {
  const response = await fetchImpl(`${API_ORIGIN}/graphql`, {
    method: "POST",
    headers: { authorization: header, "content-type": "application/json" },
    body: JSON.stringify({
      query: BASE_LAG_QUERY,
      // **どのリポジトリかは要求ごとに決まる**（設定に固定しない。§1）
      variables: { owner: repository.owner, name: repository.name, base, head },
    }),
    signal: deadline,
  });
  return response.ok ? toBehindBy(safeJson(await response.text())) : undefined;
}

/**
 * 読めたぶんだけ、**合流の状況へ数を足す**。
 *
 * **1 本ずつ訊く**（`collectSummaries` と同じ形）——**GraphQL の引数は node ごとに
 * 変えられない**ので、**1 要求で全部は取れない。** **合図を見たら、取れたぶんを持って返る。**
 *
 * **落ちても投げない**（`readMergeStatuses` と同じ判断）——**数が出ないだけ**で、
 * **盤面も合流の状況も残る。**
 *
 * **数が要るのは、状況を持っている PR だけではない。** **状況が読めなかった PR にも
 * 数は出せる**が、**その行は「まだ分かりません」と出る**ので、**足し先が無い**
 * ——**地図に在るものにだけ足す。**
 */
async function addBaseLags({
  fetchImpl,
  repository,
  header,
  refs,
  mergeStatuses,
  deadline,
}: {
  fetchImpl: typeof fetch;
  repository: GitHubRepository;
  header: string;
  refs: { pullRequests: readonly PullRequestRef[]; heads: ReadonlyMap<number, string> };
  mergeStatuses: Map<number, MergeStatusReport>;
  deadline: AbortSignal;
}): Promise<void> {
  for (const pullRequest of refs.pullRequests) {
    // **切れているなら呼ばない**——**呼べば往復が始まる**（`collectChanges` と同じ）
    if (deadline.aborted) {
      return;
    }
    const head = refs.heads.get(pullRequest.number);
    const status = mergeStatuses.get(pullRequest.number);
    // **相手が無いなら聞かない。** **head を読めなかった PR**（`heads` に入らない）と、
    // **状況そのものを読めなかった PR**（地図に無い）である
    if (head === undefined || status === undefined) {
      continue;
    }
    const behindBy = await readBaseLag(
      fetchImpl,
      repository,
      header,
      pullRequest.base.branch,
      head,
      deadline,
      // **1 本の失敗で全体を消さない**（`collectSummaries` と同じ）——**取り消しの跡も
      // ここへ来る**が、**次の周で `deadline.aborted` を見て抜ける。**
    ).catch(() => undefined);
    if (behindBy !== undefined) {
      mergeStatuses.set(pullRequest.number, { ...status, behindBy });
    }
  }
}
