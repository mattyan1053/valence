/**
 * `PullRequestApprovals` の GitHub 実装（#343）。
 *
 * **読むのもユーザートークンである**（`AGENTS.md` §6）。**installation トークンで
 * 代用しない**——**あれは「リポジトリへの操作」**なので、**誰がログインしていても
 * 同じ答えになる。**
 *
 * **承認かどうかの規則は GitHub に決めさせる**（§5。**#330 で「自己承認は GitHub に
 * 判定させる」を選んだのと同じ**）。**`latestOpinionatedReviews` は、著者ごとの
 * 最新の意見だけを並べ**、**取り下げられた承認を落とす**——**その規則をこちらへ
 * 写すと、向こうが変わったときに片方だけ古くなる。**
 *
 * **REST ではなく GraphQL を使うのは、その一覧が REST に無いから**である。
 * **`GET /pulls/{n}/reviews` は取り下げも古い意見もそのまま並べる**ので、
 * **「どれが有効か」をこちらで数え直すことになる。**
 *
 * **内側の接続も辿る** (#346 のレビュー)。**`pageInfo` を持つのは外側だけではない**
 * ——**意見が 100 件を超えた PR で、唯一の承認が次のページにあると
 * 「承認されていない」に化ける**（**#322 で 1 度直した罠**）。
 *
 * **合図は口まで通す** (#346 のレビュー)。**先に返すだけでは、走っている要求は
 * 走り続ける**（`ChangeSummaryRequest` と同じ理由）。
 *
 * **検証済みのものだけを内側へ入れる**（§3）。
 */

import { z } from "zod";
import type {
  PullRequestApprovalListing,
  PullRequestApprovalRequest,
  PullRequestApprovals,
} from "../../application/ports/pull-request-approvals";
import type { VisibleRepository } from "../../application/ports/visible-repositories";

const API_ORIGIN = "https://api.github.com";

/** 1 度に読む件数。**GraphQL の上限は 100。** */
const PAGE_SIZE = 100;

/**
 * 開いている PR と、その最新の意見。
 *
 * **`states: OPEN` で絞る。** **盤面に並ぶのは開いている PR** であり、
 * **閉じたものは「読めなかった」側へ落ちる**（**承認されていない、とは言わない**）。
 */
/**
 * **聞かれた番号だけを引く**（#668）。
 *
 * **前は開いている PR の一覧を丸ごと辿っていた**——**1 本聞かれても最後のページまで
 * 消費する**ので、**`heads` が 1 件でも、open PR の本数ぶんの往復**になっていた。
 *
 * **実測（2026-09-10、この機械）**: **open 898 本のリポジトリで、一覧の全ページを
 * 辿ると 9 ページ・34.9 秒**。**同じリポジトリで 1 本を番号で引くと 1.2〜1.5 秒**、
 * **50 本をまとめて 1 問い合わせにしても 1.8〜2.8 秒**だった。
 *
 * **まとめる数は一覧のページと同じ**（`PAGE_SIZE`）——**全部を聞かれた場合でも
 * 往復の数は前と変わらない**（**`ceil(件数 / 100)`**）。**減るのは「聞いていない
 * PR のぶん」だけ**である。
 *
 * **`state` も一緒に読む。** **前は `states: OPEN` の一覧に居ることが「開いている」の
 * 根拠だった**——**番号で引くと閉じた PR も返る**ので、**ここで見ないと、
 * 閉じた PR が承認済みの顔をする。**
 *
 * **別名は番号から作る**（`p123`）——**GraphQL の名前に使えるのは英数字と `_`** で、
 * **数字始まりは通らない。**
 */
function askedQuery(numbers: readonly number[]): string {
  const asked = numbers
    .map(
      (number) =>
        `p${number}: pullRequest(number: ${number}) { number state latestOpinionatedReviews(first: ${PAGE_SIZE}) { pageInfo { hasNextPage endCursor } nodes { state commit { oid } } } }`,
    )
    .join(" ");
  return `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${asked} } }`;
}

const REVIEWS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      latestOpinionatedReviews(first: ${PAGE_SIZE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { state commit { oid } }
      }
    }
  }
}`;

const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const reviewsSchema = z.object({
  pageInfo: pageInfoSchema,
  nodes: z.array(
    z.object({
      state: z.string(),
      // **null になりうる**（#635）——**承認が付いた commit が force push で消えている。**
      // **消えているなら head ではない**ので、**承認済みとは言わない。**
      commit: z.object({ oid: z.string() }).nullable(),
    }),
  ),
});

/** 意見の 1 ページ。**内側の接続も、外側と同じ形をしている。** */
type ReviewsPage = z.infer<typeof reviewsSchema>;

/**
 * 使う項目だけを検証する。
 *
 * **`errors` が載っていたら読まない。** **GraphQL は 200 のまま失敗を返す**ので、
 * **状態コードだけを見ると「1 件も承認されていない」として通ってしまう。**
 */
/**
 * 聞かれた番号ぶんの応答。**別名で引くので、鍵は `p<番号>`** である。
 *
 * **見つからなかった PR は `null` で返る**——**「読めなかった」側**である。
 */
const askedSchema = z.object({
  // **GraphQL は 200 で `data` と `errors` を同時に返す**ことがあり、
  // **`z.object` は知らない鍵を捨てる**ので、**そのままだと部分的な応答が通る。**
  // **`z.never().optional()` は「無いときだけ通る」**——**載っていたら落ちる。**
  errors: z.never().optional(),
  data: z.object({
    repository: z.record(
      z.string(),
      z
        .object({
          number: z.number().int().positive(),
          state: z.string(),
          latestOpinionatedReviews: reviewsSchema,
        })
        .nullable(),
    ),
  }),
});

const reviewsPageSchema = z.object({
  // **こちらも同じ**（**カーソルの解決に失敗した応答がここへ来る**）
  errors: z.never().optional(),
  data: z.object({
    repository: z.object({
      pullRequest: z.object({ latestOpinionatedReviews: reviewsSchema }),
    }),
  }),
});

/**
 * 読めなかったときのエラー。
 *
 * **応答の中身を載せない**（§6「出力に何が含まれうるかで判断する」）——
 * **この要求の応答には、そのユーザーの持ち物が並ぶ。** **載せるのは状態コードだけ。**
 */
class ApprovalLookupFailed extends Error {
  constructor(status: number) {
    super(`GitHub が承認の状態を返しませんでした (status ${status})`);
    this.name = "ApprovalLookupFailed";
  }
}

export type GitHubPullRequestApprovalsOptions = {
  /** **差し替えるための引数であって、抽象ではない**（#64 と同じ形）。 */
  readonly fetchImpl?: typeof fetch;
};

export function createGitHubPullRequestApprovals({
  fetchImpl = fetch,
}: GitHubPullRequestApprovalsOptions = {}): PullRequestApprovals {
  /** GraphQL を 1 回叩いて、**検証したものだけ**を返す。 */
  async function ask(
    userAccessToken: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly status: number; readonly payload: unknown }> {
    const response = await fetchImpl(`${API_ORIGIN}/graphql`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${userAccessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      // **合図を口まで通す**——**先に返すだけでは、走っている要求は走り続ける**
      signal,
    });
    if (!response.ok) {
      throw new ApprovalLookupFailed(response.status);
    }
    return { status: response.status, payload: await response.json().catch(() => undefined) };
  }

  /**
   * **聞かれた番号ぶんを 1 回で引く**（#668）。
   *
   * **開いていない PR は持ち帰らない**——**`states: OPEN` の一覧に居ることが
   * 「開いている」の根拠だった**ので、**番号で引くようになった以上、ここで見る。**
   */
  async function readAsked(
    userAccessToken: string,
    repository: VisibleRepository,
    numbers: readonly number[],
    signal: AbortSignal | undefined,
  ): Promise<ReadonlyMap<number, ReviewsPage>> {
    const { status, payload } = await ask(
      userAccessToken,
      {
        query: askedQuery(numbers),
        // **どのリポジトリかは要求ごとに決まる**（設定に固定しない。§1）
        variables: { owner: repository.owner, name: repository.name },
      },
      signal,
    );
    const parsed = askedSchema.safeParse(payload);
    if (!parsed.success) {
      // **`errors` だけが返った応答もここへ来る**——**「承認されていない」にしない**
      throw new ApprovalLookupFailed(status);
    }
    const found = new Map<number, ReviewsPage>();
    for (const pullRequest of Object.values(parsed.data.data.repository)) {
      // **見つからなかった（`null`）／開いていない PR は入れない**——
      // **入れないものは「読めなかった」側**として返る
      if (pullRequest !== null && pullRequest.state === "OPEN") {
        found.set(pullRequest.number, pullRequest.latestOpinionatedReviews);
      }
    }
    return found;
  }

  /** 意見の続き 1 ページ。 */
  async function readReviewsPage(
    userAccessToken: string,
    repository: VisibleRepository,
    number: number,
    cursor: string,
    signal: AbortSignal | undefined,
  ): Promise<ReviewsPage> {
    const { status, payload } = await ask(
      userAccessToken,
      {
        query: REVIEWS_QUERY,
        variables: { owner: repository.owner, name: repository.name, number, cursor },
      },
      signal,
    );
    const parsed = reviewsPageSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ApprovalLookupFailed(status);
    }
    return parsed.data.data.repository.pullRequest.latestOpinionatedReviews;
  }

  /**
   * 次のページの位置。**続きがあると言いながら行き先が無いなら、読めていない。**
   *
   * **黙って止めない** (#346 のレビュー 2 周目)——**外側なら「一覧に無い」へ、
   * 内側なら「承認されていない」へ落ちる**。**どちらも、読めていないだけである。**
   */
  function nextCursor(pageInfo: { hasNextPage: boolean; endCursor: string | null }): string {
    if (pageInfo.endCursor === null) {
      throw new ApprovalLookupFailed(200);
    }
    return pageInfo.endCursor;
  }

  /**
   * その PR の **head を承認した意見が 1 つでもあるか**（#635）。
   *
   * **「承認がある」では足りない。** **承認は commit に付く**ので、
   * **そのあとに push されたら、誰も読んでいない差分が承認済みの顔をする。**
   *
   * **内側の続きも辿る** (#346 のレビュー)——**意見が 100 件を超えた PR で、
   * 唯一の承認が次のページにあると「承認されていない」に化ける。**
   * **見つかった時点で止める**（要らない往復を作らない）——**ただし、止める条件は
   * 「head に付いた承認」である**（**古い承認で止めると、head を承認した人が
   * 次のページにいる PR で「承認されていない」に化ける**）。
   */
  async function approvesHead(
    userAccessToken: string,
    repository: VisibleRepository,
    number: number,
    head: string,
    firstPage: ReviewsPage,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    let page = firstPage;
    for (;;) {
      if (page.nodes.some((review) => review.state === "APPROVED" && review.commit?.oid === head)) {
        return true;
      }
      if (!page.pageInfo.hasNextPage) {
        return false;
      }
      page = await readReviewsPage(
        userAccessToken,
        repository,
        number,
        nextCursor(page.pageInfo),
        signal,
      );
    }
  }

  /**
   * **1 回ぶんを引いて、答えを積む**（#668）。
   *
   * **`listApprovals` から切り出してある**——**まとめて引く輪と、1 件ずつ
   * 意見の続きを辿る輪が同じ関数に入ると、読む側が両方を一度に持つ。**
   */
  async function collect({
    userAccessToken,
    repository,
    heads,
    numbers,
    signal,
    approved,
    seen,
  }: {
    readonly userAccessToken: string;
    readonly repository: VisibleRepository;
    readonly heads: ReadonlyMap<number, string>;
    readonly numbers: readonly number[];
    readonly signal: AbortSignal | undefined;
    readonly approved: Set<number>;
    readonly seen: Set<number>;
  }): Promise<void> {
    for (const [number, reviews] of await readAsked(userAccessToken, repository, numbers, signal)) {
      const head = heads.get(number);
      if (head === undefined) {
        // **聞いていない番号が返ることは無い**が、**返っても持ち帰らない**
        continue;
      }
      seen.add(number);
      if (await approvesHead(userAccessToken, repository, number, head, reviews, signal)) {
        approved.add(number);
      }
    }
  }

  return {
    async listApprovals(
      userAccessToken: string,
      repository: VisibleRepository,
      heads: ReadonlyMap<number, string>,
      request?: PullRequestApprovalRequest,
    ): Promise<PullRequestApprovalListing> {
      // **聞かれていなければ叩かない**——**空の一覧で往復を作らない**
      if (heads.size === 0) {
        return { approved: new Set(), unavailable: [] };
      }

      const approved = new Set<number>();
      const seen = new Set<number>();
      const signal = request?.signal;

      // **聞かれた番号だけを、まとめて引く**（#668）——**前は開いている PR の一覧を
      // 丸ごと辿っていた**ので、**1 本聞かれても本数ぶんの往復**になっていた。
      // **まとめる数は一覧のページと同じ**なので、**全部を聞かれたときの往復は変わらない**
      const asked = [...heads.keys()];
      for (let from = 0; from < asked.length; from += PAGE_SIZE) {
        await collect({
          userAccessToken,
          repository,
          heads,
          numbers: asked.slice(from, from + PAGE_SIZE),
          signal,
          approved,
          seen,
        });
      }

      return {
        approved,
        // **答えが返らなかった PR は「読めなかった」**（**承認されていない、ではない**）
        // ——**閉じた PR や、番号で引いて見つからなかったものがここへ来る**
        unavailable: [...heads.keys()]
          .filter((number) => !seen.has(number))
          .map((pullRequestNumber) => ({
            pullRequestNumber,
            reason: "開いている PR として読めませんでした",
          })),
      };
    },
  };
}
