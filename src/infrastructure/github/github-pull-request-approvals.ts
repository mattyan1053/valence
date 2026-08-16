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
 * **検証済みのものだけを内側へ入れる**（§3）。
 */

import { z } from "zod";
import type {
  PullRequestApprovalListing,
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
const QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: ${PAGE_SIZE}, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        latestOpinionatedReviews(first: ${PAGE_SIZE}) { nodes { state } }
      }
    }
  }
}`;

/**
 * 使う項目だけを検証する。
 *
 * **`errors` が載っていたら読まない。** **GraphQL は 200 のまま失敗を返す**ので、
 * **状態コードだけを見ると「1 件も承認されていない」として通ってしまう。**
 */
const responseSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequests: z.object({
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
        nodes: z.array(
          z.object({
            number: z.number().int().positive(),
            latestOpinionatedReviews: z.object({
              nodes: z.array(z.object({ state: z.string() })),
            }),
          }),
        ),
      }),
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
  async function readPage(
    userAccessToken: string,
    repository: VisibleRepository,
    cursor: string | undefined,
  ) {
    const response = await fetchImpl(`${API_ORIGIN}/graphql`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${userAccessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: QUERY,
        // **どのリポジトリかは要求ごとに決まる**（設定に固定しない。§1）
        variables: { owner: repository.owner, name: repository.name, cursor: cursor ?? null },
      }),
    });
    if (!response.ok) {
      throw new ApprovalLookupFailed(response.status);
    }

    const parsed = responseSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
      // **`errors` だけが返った応答もここへ来る**——**「承認されていない」にしない**
      throw new ApprovalLookupFailed(response.status);
    }
    return parsed.data.data.repository.pullRequests;
  }

  /** 開いている PR を、最後のページまで並べる。 */
  async function* readAll(userAccessToken: string, repository: VisibleRepository) {
    let cursor: string | undefined;
    for (;;) {
      const listing = await readPage(userAccessToken, repository, cursor);
      yield* listing.nodes;
      if (!listing.pageInfo.hasNextPage || listing.pageInfo.endCursor === null) {
        return;
      }
      cursor = listing.pageInfo.endCursor;
    }
  }

  return {
    async listApprovals(
      userAccessToken: string,
      repository: VisibleRepository,
      pullRequestNumbers: readonly number[],
    ): Promise<PullRequestApprovalListing> {
      // **聞かれていなければ叩かない**——**空の一覧で往復を作らない**
      if (pullRequestNumbers.length === 0) {
        return { approved: new Set(), unavailable: [] };
      }

      const wanted = new Set(pullRequestNumbers);
      const approved = new Set<number>();
      const seen = new Set<number>();

      // **最後のページまで読む。** **打ち切ると、古い PR から状態が消える**
      // ——**症状は「承認したのに出ない」**で、**この Issue が消しに来たもの**である
      for await (const node of readAll(userAccessToken, repository)) {
        if (!wanted.has(node.number)) {
          // **聞いていない PR は持ち帰らない**
          continue;
        }
        seen.add(node.number);
        // **1 人でも「最新の意見が承認」なら承認済み**——**数え方は GitHub が持つ**
        if (hasApproval(node.latestOpinionatedReviews.nodes)) {
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

/** **最新の意見に承認が 1 つでもあるか。** */
function hasApproval(reviews: readonly { readonly state: string }[]): boolean {
  return reviews.some((review) => review.state === "APPROVED");
}
