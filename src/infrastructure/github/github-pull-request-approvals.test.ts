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

type Node = { number: number; states: string[] };

/** 1 ページぶんの応答。**続きがあるかは `endCursor` で表す。** */
function page(nodes: readonly Node[], endCursor?: string): unknown {
  return {
    data: {
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: endCursor !== undefined, endCursor: endCursor ?? null },
          nodes: nodes.map(({ number, states }) => ({
            number,
            latestOpinionatedReviews: { nodes: states.map((state) => ({ state })) },
          })),
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
