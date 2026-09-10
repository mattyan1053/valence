/**
 * `CrossRepositoryPullRequests` の GitHub 実装（#662）。
 *
 * **1 要求に別名で並べる。** **往復はリポジトリ数に依らない**——**実測（2026-09-11）**:
 * **見えるリポジトリ 50 件を 1 要求にまとめて 3.0〜3.4 秒**（**本文 7.7 KB**）。
 * **盤面を N 枚重ねると往復だけで 100 回超**で、**1 往復 1.3 秒なら 2 分**である。
 *
 * **1 つが読めなくても、他を出す。** **GraphQL は部分的な応答を返す**
 * ——**読めたものは `data` に、読めなかったものは `null` + `errors[].path`**（実測）。
 * **`errors` を読み落とすと、`null` が「PR が 0 本」に化ける。**
 *
 * **owner / name は変数で渡す**（§3）——**外から来る値を問い合わせ本文へ埋め込まない。**
 *
 * **ユーザートークンで引く**（§6）。**installation トークンで代用しない**
 * ——**あれは「リポジトリへの操作」**なので、**誰がログインしていても同じものが見える。**
 */

import { z } from "zod";
import type {
  CrossRepositoryListing,
  CrossRepositoryPullRequest,
  CrossRepositoryPullRequests,
  CrossRepositoryRequest,
  InvalidCrossRepositoryPullRequest,
  UnavailableRepository,
} from "../../application/ports/cross-repository-pull-requests";
import type { VisibleRepository } from "../../application/ports/visible-repositories";
import type { MergeStatusReport } from "../../domain/graph/merge-readiness";
import type { Assignment } from "../../domain/triage/assignment";
import type { ReviewOpinion } from "../../domain/triage/ball";
import { judgedOpinionOf, mergeStatusOf } from "./merge-status-mapping";

const API_ORIGIN = "https://api.github.com";

/** 1 リポジトリから 1 度に読む件数。**GraphQL の上限は 100。** */
const PAGE_SIZE = 100;

/**
 * 1 要求に並べるリポジトリの数。
 *
 * **上限に当たる件数を測った**（#681 の「気をつけること」。2026-09-11）。
 *
 * | 並べた数 | 結果 |
 * | --- | --- |
 * | **50 件** | **`MAX_NODE_LIMIT_EXCEEDED`**（**555,000 > 500,000**） |
 * | **25 件** | **2.4〜5.2 秒**（**通る**） |
 *
 * **node の数は「リポジトリ × PR × 意見」で効く**——**25 × 100 × (1 + 10 + 10 + 100)
 * ≈ 302,500** である。**件数を増やすより、要求を分けるほうが速い**
 * （**50 件を 1 要求に詰めて意見を 20 件へ削ると 7.9 秒**だった）。
 *
 * **超えたぶんは要求を分け、並べて投げる**——**50 件で 4.0〜4.4 秒**
 * （**順に投げると 6.4〜7.2 秒**）。
 */
const BATCH_SIZE = 25;

/** **応答の中身をエラーに載せない**（§6）。秘密が混ざりうる。 */
class CrossRepositoryLookupFailed extends Error {
  constructor(status: number) {
    super(`GitHub から横断の PR 一覧を取得できませんでした (HTTP ${status})`);
    this.name = "CrossRepositoryLookupFailed";
  }
}

const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  updatedAt: z.string().min(1),
});

/**
 * head の commit。**別に読む**——**1 つ読めないだけで、その PR ごと捨てない。**
 */
const headSchema = z.object({ headRefOid: z.string().min(1) });

/**
 * 誰に振られているか（#631）。
 *
 * **bot は `__typename` で見る**——**login の `[bot]` で判定しない**
 * （`pull-request-mapping.ts` と同じ判断。**あちらは REST の `user.type`** で、
 * **口が違うだけで規則は同じ**である）。
 *
 * **依頼のうち User でないもの**（team）**は login を持たない**ので、**数えない。**
 */
const assignmentSchema = z.object({
  author: z.object({ __typename: z.string(), login: z.string().min(1) }).nullable(),
  assignees: z.object({ nodes: z.array(z.object({ login: z.string().min(1) })) }),
  reviewRequests: z.object({
    nodes: z.array(
      z.object({ requestedReviewer: z.object({ login: z.string().min(1) }).nullish() }),
    ),
  }),
});

/**
 * **1 往復で取れるものを、その 1 往復で全部読む**（#681）——**どれも同じ node の中**。
 *
 * **読めなかったものは持たない**——**`ballOf` / `mergeReadinessOf` /
 * `assignmentStateOf` が「分からない」へ倒す**ので、**「放置」「マージできる」
 * 「誰も持っていない」に化けない**（`AGENTS.md` §5。**6 回塞いだ形**）。
 */
function materialsOf(node: unknown): {
  readonly head?: string;
  readonly mergeStatus?: MergeStatusReport;
  readonly opinion?: ReviewOpinion;
  readonly assignment?: Assignment;
} {
  const head = headSchema.safeParse(node);
  const status = mergeStatusOf(node);
  const opinion = judgedOpinionOf(node);
  const assignment = assignmentOf(node);
  return {
    ...(head.success ? { head: head.data.headRefOid } : {}),
    ...(status === undefined ? {} : { mergeStatus: status.status }),
    ...(opinion === undefined ? {} : { opinion: opinion.judged.opinion }),
    ...(assignment === undefined ? {} : { assignment }),
  };
}

function assignmentOf(item: unknown): Assignment | undefined {
  const parsed = assignmentSchema.safeParse(item);
  if (!parsed.success) {
    return undefined;
  }
  return {
    assignees: parsed.data.assignees.nodes.map((assignee) => assignee.login),
    reviewers: parsed.data.reviewRequests.nodes.flatMap((request) =>
      request.requestedReviewer?.login === undefined ? [] : [request.requestedReviewer.login],
    ),
    authoredByBot: parsed.data.author?.__typename === "Bot",
  };
}

const boxSchema = z.object({
  pullRequests: z.object({
    totalCount: z.number().int().nonnegative(),
    nodes: z.array(z.unknown()),
  }),
});

const responseSchema = z.object({
  data: z.record(z.string(), z.unknown()).nullish(),
});

/** 別名を作る。**位置から決まる**ので、応答を並びへ戻せる。 */
function aliasOf(index: number): string {
  return `r${index}`;
}

/**
 * 1 要求ぶんの問い合わせ。
 *
 * **`states: OPEN` で絞る**——**盤面に並ぶのは開いている PR** である。
 * **依存を作る材料（base/head）は取らない**（#662 の本文）
 * ——**依存グラフはリポジトリを跨がない**ので、**跨ぐほうが難しい形にしてある。**
 */
function queryFor(count: number): string {
  const parameters = Array.from(
    { length: count },
    (_, index) => `$o${index}:String!,$n${index}:String!`,
  ).join(",");
  const boxes = Array.from(
    { length: count },
    (_, index) =>
      `  ${aliasOf(index)}: repository(owner:$o${index}, name:$n${index}){` +
      ` pullRequests(states:OPEN, first:${PAGE_SIZE}, orderBy:{field:UPDATED_AT, direction:DESC}){` +
      " totalCount nodes{ number title updatedAt headRefOid mergeable mergeStateStatus" +
      " author{ __typename login }" +
      " assignees(first:10){ nodes{ login } }" +
      " reviewRequests(first:10){ nodes{ requestedReviewer{ ... on User{ login } } } }" +
      " reviews{ totalCount }" +
      ` latestOpinionatedReviews(first:${PAGE_SIZE}){ pageInfo{ hasNextPage } nodes{ state commit{ oid } } }` +
      " } } }",
  ).join("\n");
  return `query(${parameters}){\n${boxes}\n}`;
}

function variablesFor(repositories: readonly VisibleRepository[]): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [index, repository] of repositories.entries()) {
    variables[`o${index}`] = repository.owner;
    variables[`n${index}`] = repository.name;
  }
  return variables;
}

export type GitHubCrossRepositoryPullRequestsOptions = {
  readonly fetchImpl?: typeof fetch;
};

export function createGitHubCrossRepositoryPullRequests({
  fetchImpl = fetch,
}: GitHubCrossRepositoryPullRequestsOptions = {}): CrossRepositoryPullRequests {
  async function ask(
    userAccessToken: string,
    repositories: readonly VisibleRepository[],
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    const response = await fetchImpl(`${API_ORIGIN}/graphql`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${userAccessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: queryFor(repositories.length),
        variables: variablesFor(repositories),
      }),
      // **合図を口まで通す**——**先に返すだけでは、走っている要求は走り続ける**
      signal,
    });
    if (!response.ok) {
      throw new CrossRepositoryLookupFailed(response.status);
    }
    const payload = await response.json().catch(() => undefined);
    const parsed = responseSchema.safeParse(payload);
    if (!parsed.success) {
      // **応答そのものが読めない。** **空の一覧を返すと「0 本」に化ける**
      throw new CrossRepositoryLookupFailed(response.status);
    }
    return parsed.data.data ?? {};
  }

  /** 1 リポジトリぶんの箱を読む。**読めた PR と、落ちた理由を分けて返す。** */
  function readBox(
    repository: VisibleRepository,
    box: unknown,
    into: {
      pullRequests: CrossRepositoryPullRequest[];
      unavailable: UnavailableRepository[];
      invalid: InvalidCrossRepositoryPullRequest[];
    },
  ): void {
    const parsed = boxSchema.safeParse(box);
    if (!parsed.success) {
      // **答えが返らなかった**（`null` / 形が違う）——**「0 本」にしない**
      into.unavailable.push({ repository, kind: "unreadable" });
      return;
    }
    const { totalCount, nodes } = parsed.data.pullRequests;
    for (const [index, node] of nodes.entries()) {
      const pullRequest = pullRequestSchema.safeParse(node);
      if (!pullRequest.success) {
        // **1 件の形が違うだけで、その箱ごと捨てない**
        into.invalid.push({ repository, index, reason: "PR の形を読み取れませんでした" });
        continue;
      }
      into.pullRequests.push({ repository, ...pullRequest.data, ...materialsOf(node) });
    }
    if (totalCount > nodes.length) {
      // **読めたぶんは一覧に入っている**——**「答えが返らなかった」と分ける**
      into.unavailable.push({ repository, kind: "truncated" });
    }
  }

  return {
    async list(
      userAccessToken: string,
      repositories: readonly VisibleRepository[],
      request?: CrossRepositoryRequest,
    ): Promise<CrossRepositoryListing> {
      const into = {
        pullRequests: [] as CrossRepositoryPullRequest[],
        unavailable: [] as UnavailableRepository[],
        invalid: [] as InvalidCrossRepositoryPullRequest[],
      };
      // **聞かれていなければ叩かない**——**空の一覧で往復を作らない**
      const batches: VisibleRepository[][] = [];
      for (let start = 0; start < repositories.length; start += BATCH_SIZE) {
        batches.push([...repositories.slice(start, start + BATCH_SIZE)]);
      }
      // **並べて投げる**——**実測で、順に投げるより 1.6 倍速い**（50 件で 4.0 秒 / 6.4 秒）
      const answers = await Promise.all(
        batches.map((batch) => ask(userAccessToken, batch, request?.signal)),
      );
      for (const [batchIndex, batch] of batches.entries()) {
        const data = answers[batchIndex] ?? {};
        for (const [index, repository] of batch.entries()) {
          readBox(repository, data[aliasOf(index)], into);
        }
      }
      return into;
    },
  };
}
