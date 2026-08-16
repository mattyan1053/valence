/**
 * `PullRequestApprovals` の GitHub 実装（#343）。
 *
 * **読むのもユーザートークンである**（`AGENTS.md` §6）——**installation トークンだと、
 * 誰がログインしていても同じ答えになる。**
 *
 * **承認かどうかの規則は GitHub に決めさせる**（§5）。**「最新の意見だけを数える」
 * 「取り下げられた承認は数えない」をこちらへ写すと、向こうが変わったときに
 * 片方だけ古くなる**——**症状は「承認したのに出ない」で、#343 が消しに来たもの**である。
 *
 * **「承認されていない」と「読めなかった」を分ける**——**混ぜると、押した人は
 * もう一度押す。**
 *
 * **モックを使わない**（§4）——**`fetch` の差し替えは抽象ではなく引数**である（#64）。
 */

import { describe, expect, it } from "vitest";
import { createGitHubPullRequestApprovals } from "./github-pull-request-approvals";

const REPOSITORY = { owner: "acme", name: "web" } as const;
const USER_TOKEN = "user-token";

type Node = { number: number; states: string[]; moreReviews?: string };

/** 1 ページぶんの応答。**続きがあるかは `endCursor` で表す。** */
function page(nodes: readonly Node[], endCursor?: string): unknown {
  return {
    data: {
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: endCursor !== undefined, endCursor: endCursor ?? null },
          nodes: nodes.map(({ number, states, moreReviews }) => ({
            number,
            latestOpinionatedReviews: {
              // **内側にも続きがある**（#346 のレビュー）——**意見の数は 100 で切れる**
              pageInfo: {
                hasNextPage: moreReviews !== undefined,
                endCursor: moreReviews ?? null,
              },
              nodes: states.map((state) => ({ state })),
            },
          })),
        },
      },
    },
  };
}

/** 1 つの PR の、意見だけの応答（**内側の続きを読む要求への答え**）。 */
function reviewPage(states: readonly string[], endCursor?: string): unknown {
  return {
    data: {
      repository: {
        pullRequest: {
          latestOpinionatedReviews: {
            pageInfo: { hasNextPage: endCursor !== undefined, endCursor: endCursor ?? null },
            nodes: states.map((state) => ({ state })),
          },
        },
      },
    },
  };
}

/** 応答を順に返す `fetch`。**何をどこへ送ったか**を控える。 */
function fetcher(
  responses: readonly { status: number; body: unknown }[],
): typeof fetch & { calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const response = responses[Math.min(calls.length - 1, responses.length - 1)];
    return new Response(JSON.stringify(response?.body), {
      status: response?.status ?? 500,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch & { calls: typeof calls };
  impl.calls = calls;
  return impl;
}

describe("GitHub から承認の状態を読む", () => {
  it("読む人のトークンで読む", async () => {
    // **installation トークンで読むと、誰がログインしていても同じ答えになる**（§6）
    const fetchImpl = fetcher([{ status: 200, body: page([{ number: 7, states: [] }]) }]);

    await createGitHubPullRequestApprovals({ fetchImpl }).listApprovals(
      USER_TOKEN,
      REPOSITORY,
      [7],
    );

    const [call] = fetchImpl.calls;
    expect(call?.url).toBe("https://api.github.com/graphql");
    expect(new Headers(call?.init?.headers).get("authorization")).toBe(`Bearer ${USER_TOKEN}`);
    // **どのリポジトリかは要求ごとに決まる**（設定に固定しない。§1）
    expect(JSON.parse(String(call?.init?.body)).variables).toMatchObject({
      owner: "acme",
      name: "web",
    });
  });

  it("承認が付いている PR を、承認済みとして返す", async () => {
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([{ status: 200, body: page([{ number: 7, states: ["APPROVED"] }]) }]),
    });

    const listing = await approvals.listApprovals(USER_TOKEN, REPOSITORY, [7]);

    expect([...listing.approved]).toEqual([7]);
    expect(listing.unavailable).toEqual([]);
  });

  it("承認が付いていない PR を、承認済みにしない", async () => {
    // **全部を承認済みにする実装でも、上の 1 件だけなら緑になる**
    // ——**付いていない側を並べて初めて、区別していることが分かる**
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([
        {
          status: 200,
          body: page([
            { number: 7, states: ["APPROVED"] },
            { number: 8, states: [] },
            { number: 9, states: ["CHANGES_REQUESTED"] },
          ]),
        },
      ]),
    });

    const listing = await approvals.listApprovals(USER_TOKEN, REPOSITORY, [7, 8, 9]);

    expect([...listing.approved]).toEqual([7]);
    expect(listing.unavailable).toEqual([]);
  });

  it("最新の意見だけを数えるのは GitHub である", async () => {
    // **取り下げられた承認や、あとから変更を求めた人の古い承認は、
    // `latestOpinionatedReviews` に出てこない**（§5。**こちらで数え直さない**）
    // ——**この試験は「その一覧をそのまま読んでいる」ことを固定する。**
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([
        {
          status: 200,
          body: page([{ number: 7, states: ["CHANGES_REQUESTED", "APPROVED"] }]),
        },
      ]),
    });

    const listing = await approvals.listApprovals(USER_TOKEN, REPOSITORY, [7]);

    // **1 人でも「最新の意見が承認」なら承認済み**である
    expect([...listing.approved]).toEqual([7]);
  });

  it("聞いていない PR は返さない", async () => {
    // **盤面に無い PR の状態を持ち帰らない**——**画面が使わないものを載せると、
    // 「どれの話か」が曖昧になる**
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([
        {
          status: 200,
          body: page([
            { number: 7, states: ["APPROVED"] },
            { number: 99, states: ["APPROVED"] },
          ]),
        },
      ]),
    });

    const listing = await approvals.listApprovals(USER_TOKEN, REPOSITORY, [7]);

    expect([...listing.approved]).toEqual([7]);
  });

  it("1 ページ目より先にある PR も読む", async () => {
    // **打ち切ると、古い PR から状態が消える**——**症状は「承認したのに出ない」**で、
    // **この Issue が消しに来たものと同じ見え方**になる
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([
        { status: 200, body: page([{ number: 7, states: [] }], "CURSOR") },
        { status: 200, body: page([{ number: 8, states: ["APPROVED"] }]) },
      ]),
    });

    const listing = await approvals.listApprovals(USER_TOKEN, REPOSITORY, [7, 8]);

    expect([...listing.approved]).toEqual([8]);
    expect(listing.unavailable).toEqual([]);
  });

  it("答えが返らなかった PR は、「承認されていない」ではなく「読めなかった」", async () => {
    // **閉じた PR や、一覧から落ちたもの**は、**状態が分からないだけ**である
    // ——**`approved` から外すだけだと、画面では承認されていないのと同じに見える**
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([{ status: 200, body: page([{ number: 7, states: ["APPROVED"] }]) }]),
    });

    const listing = await approvals.listApprovals(USER_TOKEN, REPOSITORY, [7, 8]);

    expect([...listing.approved]).toEqual([7]);
    expect(listing.unavailable.map((row) => row.pullRequestNumber)).toEqual([8]);
  });

  it("意見が 100 件を超えても、承認を取りこぼさない", async () => {
    // **内側の接続にも `pageInfo` がある**（#346 のレビュー。**#322 で 1 度直した罠**）
    // ——**辿らないと、唯一の承認が次のページにある PR で「承認されていない」に化ける。**
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([
        {
          status: 200,
          body: page([{ number: 7, states: ["CHANGES_REQUESTED"], moreReviews: "REVIEWS" }]),
        },
        { status: 200, body: reviewPage(["APPROVED"]) },
      ]),
    });

    const listing = await approvals.listApprovals(USER_TOKEN, REPOSITORY, [7]);

    expect([...listing.approved], "内側の続きを読んでいない").toEqual([7]);
    expect(listing.unavailable).toEqual([]);
  });

  it("続きを読んでも承認が無ければ、承認済みにしない", async () => {
    // **「読んだ」と「あった」を混ぜない**——**辿った先に無ければ、無いのである**
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([
        {
          status: 200,
          body: page([{ number: 7, states: ["CHANGES_REQUESTED"], moreReviews: "REVIEWS" }]),
        },
        { status: 200, body: reviewPage(["CHANGES_REQUESTED"]) },
      ]),
    });

    const listing = await approvals.listApprovals(USER_TOKEN, REPOSITORY, [7]);

    expect([...listing.approved]).toEqual([]);
    expect(listing.unavailable).toEqual([]);
  });

  it("承認が 1 ページ目にあれば、続きは読まない", async () => {
    // **要らない往復を作らない**——**1 人でも承認していれば、そこで決まる**
    const fetchImpl = fetcher([
      {
        status: 200,
        body: page([{ number: 7, states: ["APPROVED"], moreReviews: "REVIEWS" }]),
      },
    ]);

    await createGitHubPullRequestApprovals({ fetchImpl }).listApprovals(
      USER_TOKEN,
      REPOSITORY,
      [7],
    );

    expect(fetchImpl.calls).toHaveLength(1);
  });

  it("打ち切りの合図を、要求へ渡す", async () => {
    // **先に返すだけでは、走っている要求は走り続ける**（`ChangeSummaryRequest` と同じ）
    const fetchImpl = fetcher([{ status: 200, body: page([{ number: 7, states: [] }]) }]);
    const controller = new AbortController();

    await createGitHubPullRequestApprovals({ fetchImpl }).listApprovals(
      USER_TOKEN,
      REPOSITORY,
      [7],
      { signal: controller.signal },
    );

    expect(fetchImpl.calls[0]?.init?.signal, "合図が口まで届いていない").toBe(controller.signal);
  });

  it("`data` と `errors` が同時に返ったら、読まない", async () => {
    // **GraphQL は部分的な成功を返す**（#346 のレビュー 2 周目）——**`z.object` は
    // 知らない鍵を捨てる**ので、**「`errors` が載っていたら読まない」と書いてあっても
    // 素通りしていた。** **読める形をしているぶん、いちばん静かに壊れる。**
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([
        {
          status: 200,
          body: {
            ...(page([{ number: 7, states: [] }]) as Record<string, unknown>),
            errors: [{ message: "Something went wrong while executing your query" }],
          },
        },
      ]),
    });

    await expect(approvals.listApprovals(USER_TOKEN, REPOSITORY, [7])).rejects.toThrow();
  });

  it("続きがあるのに辿れないなら、承認されていないことにしない", async () => {
    // **`hasNextPage: true` なのに `endCursor` が無い**——**辿れないだけ**であって、
    // **「意見はここで終わり」ではない**（#346 のレビュー 2 周目）。
    // **黙って止まると、次のページの承認が未承認として出る。**
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([
        {
          status: 200,
          body: {
            data: {
              repository: {
                pullRequests: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      number: 7,
                      latestOpinionatedReviews: {
                        // **続きがあると言いながら、行き先が無い**
                        pageInfo: { hasNextPage: true, endCursor: null },
                        nodes: [{ state: "CHANGES_REQUESTED" }],
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      ]),
    });

    await expect(approvals.listApprovals(USER_TOKEN, REPOSITORY, [7])).rejects.toThrow();
  });

  it("PR の一覧も、続きを辿れないなら投げる", async () => {
    // **外側でも同じ**——**打ち切ると、読めていない PR が「一覧に無い」へ落ちる**
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([
        {
          status: 200,
          body: {
            data: {
              repository: {
                pullRequests: {
                  pageInfo: { hasNextPage: true, endCursor: null },
                  nodes: [],
                },
              },
            },
          },
        },
      ]),
    });

    await expect(approvals.listApprovals(USER_TOKEN, REPOSITORY, [7])).rejects.toThrow();
  });

  it("読めなければ投げる", async () => {
    // **空の一覧を返すと、「読めなかった」が「1 件も承認されていない」に化ける**
    // ——**理由つきで残すのは呼ぶ側**である（port の約束）
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([{ status: 502, body: { message: "bad gateway" } }]),
    });

    await expect(approvals.listApprovals(USER_TOKEN, REPOSITORY, [7])).rejects.toThrow();
  });

  it("GraphQL がエラーを返したときも投げる", async () => {
    // **`data` が空でも 200 が返る**——**状態コードだけを見ると、
    // 「1 件も承認されていない」として通ってしまう**
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([
        { status: 200, body: { errors: [{ message: "Could not resolve to a Repository" }] } },
      ]),
    });

    await expect(approvals.listApprovals(USER_TOKEN, REPOSITORY, [7])).rejects.toThrow();
  });

  it("応答の中身を、例外の文言へ載せない", async () => {
    // **応答にはそのユーザーの持ち物が並びうる**（§6）——**載せるのは状態コードだけ**
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([{ status: 403, body: { message: "secret-repository-name" } }]),
    });

    await expect(approvals.listApprovals(USER_TOKEN, REPOSITORY, [7])).rejects.toThrow(
      /^(?!.*secret-repository-name).*$/,
    );
  });

  it("聞かれていなければ、叩きに行かない", async () => {
    // **空の一覧で往復を作らない**
    const fetchImpl = fetcher([{ status: 200, body: page([]) }]);

    const listing = await createGitHubPullRequestApprovals({ fetchImpl }).listApprovals(
      USER_TOKEN,
      REPOSITORY,
      [],
    );

    expect(fetchImpl.calls).toEqual([]);
    expect([...listing.approved]).toEqual([]);
    expect(listing.unavailable).toEqual([]);
  });
});
