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
const BOARD_QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: ${PAGE_SIZE}, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        latestOpinionatedReviews(first: ${PAGE_SIZE}) {
          pageInfo { hasNextPage endCursor }
          nodes { state }
        }
      }
    }
  }
}`;

/**
 * 1 つの PR の、意見の続き。
 *
 * **承認が見つかるまでしか読まない**——**1 人でも「最新の意見が承認」なら
 * そこで決まる**（要らない往復を作らない）。
 */
const REVIEWS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      latestOpinionatedReviews(first: ${PAGE_SIZE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { state }
      }
    }
  }
}`;

const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const reviewsSchema = z.object({
  pageInfo: pageInfoSchema,
  nodes: z.array(z.object({ state: z.string() })),
});

/** 意見の 1 ページ。**内側の接続も、外側と同じ形をしている。** */
type ReviewsPage = z.infer<typeof reviewsSchema>;

/**
 * 使う項目だけを検証する。
 *
 * **`errors` が載っていたら読まない。** **GraphQL は 200 のまま失敗を返す**ので、
 * **状態コードだけを見ると「1 件も承認されていない」として通ってしまう。**
 */
const boardSchema = z.object({
  // **部分的な成功も弾く** (#346 のレビュー 2 周目)。**GraphQL は `data` と `errors` を
  // 同時に返す**ことがあり、**`z.object` は知らない鍵を捨てる**ので、
  // **「`errors` が載っていたら読まない」と書いてあっても素通りしていた。**
  // **`z.never().optional()` は「無いときだけ通る」**——**載っていたら落ちる。**
  errors: z.never().optional(),
  data: z.object({
    repository: z.object({
      pullRequests: z.object({
        pageInfo: pageInfoSchema,
        nodes: z.array(
          z.object({
            number: z.number().int().positive(),
            latestOpinionatedReviews: reviewsSchema,
          }),
        ),
      }),
    }),
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
  ): Promise<unknown> {
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

  /** 開いている PR の 1 ページ。 */
  async function readBoardPage(
    userAccessToken: string,
    repository: VisibleRepository,
    cursor: string | undefined,
    signal: AbortSignal | undefined,
  ) {
    const { status, payload } = (await ask(
      userAccessToken,
      {
        query: BOARD_QUERY,
        // **どのリポジトリかは要求ごとに決まる**（設定に固定しない。§1）
        variables: { owner: repository.owner, name: repository.name, cursor: cursor ?? null },
      },
      signal,
    )) as { status: number; payload: unknown };
    const parsed = boardSchema.safeParse(payload);
    if (!parsed.success) {
      // **`errors` だけが返った応答もここへ来る**——**「承認されていない」にしない**
      throw new ApprovalLookupFailed(status);
    }
    return parsed.data.data.repository.pullRequests;
  }

  /** 意見の続き 1 ページ。 */
  async function readReviewsPage(
    userAccessToken: string,
    repository: VisibleRepository,
    number: number,
    cursor: string,
    signal: AbortSignal | undefined,
  ): Promise<ReviewsPage> {
    const { status, payload } = (await ask(
      userAccessToken,
      {
        query: REVIEWS_QUERY,
        variables: { owner: repository.owner, name: repository.name, number, cursor },
      },
      signal,
    )) as { status: number; payload: unknown };
    const parsed = reviewsPageSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ApprovalLookupFailed(status);
    }
    return parsed.data.data.repository.pullRequest.latestOpinionatedReviews;
  }

  /** 開いている PR を、最後のページまで並べる。 */
  async function* readBoard(
    userAccessToken: string,
    repository: VisibleRepository,
    signal: AbortSignal | undefined,
  ) {
    let cursor: string | undefined;
    for (;;) {
      const listing = await readBoardPage(userAccessToken, repository, cursor, signal);
      yield* listing.nodes;
      if (!listing.pageInfo.hasNextPage) {
        return;
      }
      cursor = nextCursor(listing.pageInfo);
    }
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
   * その PR に、承認が 1 つでもあるか。
   *
   * **内側の続きも辿る** (#346 のレビュー)——**意見が 100 件を超えた PR で、
   * 唯一の承認が次のページにあると「承認されていない」に化ける。**
   * **見つかった時点で止める**（要らない往復を作らない）。
   */
  async function hasApproval(
    userAccessToken: string,
    repository: VisibleRepository,
    number: number,
    firstPage: ReviewsPage,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    let page = firstPage;
    for (;;) {
      if (page.nodes.some((review) => review.state === "APPROVED")) {
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

  return {
    async listApprovals(
      userAccessToken: string,
      repository: VisibleRepository,
      pullRequestNumbers: readonly number[],
      request?: PullRequestApprovalRequest,
    ): Promise<PullRequestApprovalListing> {
      // **聞かれていなければ叩かない**——**空の一覧で往復を作らない**
      if (pullRequestNumbers.length === 0) {
        return { approved: new Set(), unavailable: [] };
      }

      const wanted = new Set(pullRequestNumbers);
      const approved = new Set<number>();
      const seen = new Set<number>();
      const signal = request?.signal;

      // **最後のページまで読む。** **打ち切ると、古い PR から状態が消える**
      // ——**症状は「承認したのに出ない」**で、**この Issue が消しに来たもの**である
      for await (const node of readBoard(userAccessToken, repository, signal)) {
        if (!wanted.has(node.number)) {
          // **聞いていない PR は持ち帰らない**
          continue;
        }
        seen.add(node.number);
        const approvedHere = await hasApproval(
          userAccessToken,
          repository,
          node.number,
          node.latestOpinionatedReviews,
          signal,
        );
        if (approvedHere) {
          approved.add(node.number);
        }
      }

      return {
        approved,
        // **答えが返らなかった PR は「読めなかった」**（**承認されていない、ではない**）
        // ——**閉じた PR や、一覧から落ちたものがここへ来る**
        unavailable: pullRequestNumbers
          .filter((number) => !seen.has(number))
          .map((pullRequestNumber) => ({
            pullRequestNumber,
            reason: "開いている PR の一覧に見つかりませんでした",
          })),
      };
    },
  };
}
