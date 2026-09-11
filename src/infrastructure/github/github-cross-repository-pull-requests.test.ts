/**
 * **見えるリポジトリを跨いで、open な PR を 1 要求で引く**（#662）。
 *
 * **測ってから決めた形**である（2026-09-11、この機械から `api.github.com` へ）。
 *
 * - **見えるリポジトリ 50 件**、**1 往復は中央 1326 ms**（10 標本）
 * - **盤面を N 枚重ねると往復だけで 100 回超**——**2 分**（**期限の 6 倍**）
 * - **50 件を 1 要求へ別名で並べると 3.0〜3.4 秒**（**本文 7.7 KB**）
 *
 * **いちばん崩れやすいのは「1 つが読めなくても他を出す」**である
 * ——**読めないリポジトリを混ぜた実測では、読めたものは返り、読めなかったものだけが
 * `null` + `errors[].path`** だった。**`errors` を読み落とすと、`null` が
 * 「PR が 0 本」に化ける。**
 */

import { describe, expect, it } from "vitest";
import type { VisibleRepository } from "../../application/ports/visible-repositories";
import { createGitHubCrossRepositoryPullRequests } from "./github-cross-repository-pull-requests";

const TOKEN = "user-token";

function repo(name: string, owner = "acme"): VisibleRepository {
  return { owner, name };
}

/** 応答を 1 つずつ返す口。**何を送ったかも控える。** */
function responding(...payloads: readonly unknown[]) {
  const sent: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  let asked = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    sent.push({
      url: String(url),
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const payload = payloads[asked] ?? payloads[payloads.length - 1];
    asked += 1;
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

/** 1 リポジトリぶんの応答。 */
function box(
  prs: readonly { number: number; title?: string; updatedAt?: string }[],
  totalCount = prs.length,
) {
  return {
    pullRequests: {
      totalCount,
      nodes: prs.map((pr) => ({
        number: pr.number,
        title: pr.title ?? `PR ${pr.number}`,
        updatedAt: pr.updatedAt ?? "2026-09-11T00:00:00Z",
      })),
    },
  };
}

describe("createGitHubCrossRepositoryPullRequests", () => {
  it("リポジトリごとに往復しない（測った大きさでまとめる）", async () => {
    // **往復は「リポジトリ数 ÷ 25」**（測定）——**N 枚重ねると 2 分**、
    // **25 件を超えて 1 要求へ詰めると `MAX_NODE_LIMIT_EXCEEDED`**
    const { sent, fetchImpl } = responding({
      data: Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`r${index}`, box([])])),
    });
    const source = createGitHubCrossRepositoryPullRequests({ fetchImpl });

    await source.list(
      TOKEN,
      Array.from({ length: 50 }, (_, index) => repo(`repo-${index}`)),
    );

    expect(sent, "1 リポジトリずつ往復している").toHaveLength(2);
  });

  it("上限を超えるほど 1 要求へ詰めない", async () => {
    // **実測: 50 件・PR 100 本・意見 100 件で 555,000 > 500,000**（`MAX_NODE_LIMIT_EXCEEDED`）
    const { sent, fetchImpl } = responding({ data: {} });
    const source = createGitHubCrossRepositoryPullRequests({ fetchImpl });

    await source.list(
      TOKEN,
      Array.from({ length: 26 }, (_, index) => repo(`repo-${index}`)),
    );

    const body = sent[0]?.body as { query: string };
    expect([...body.query.matchAll(/repository\(/g)], "1 要求へ詰めすぎている").toHaveLength(25);
  });

  it("リポジトリと番号の対で返る", async () => {
    // **跨ぐので、番号だけでは 1 本を指せない**
    const { fetchImpl } = responding({
      data: {
        r0: box([{ number: 7, title: "図を出す", updatedAt: "2026-09-10T10:00:00Z" }]),
        r1: box([{ number: 3 }]),
      },
    });
    const source = createGitHubCrossRepositoryPullRequests({ fetchImpl });

    const listing = await source.list(TOKEN, [repo("web"), repo("api", "other")]);

    expect(listing.pullRequests).toEqual([
      {
        repository: { owner: "acme", name: "web" },
        number: 7,
        title: "図を出す",
        updatedAt: "2026-09-10T10:00:00Z",
      },
      {
        repository: { owner: "other", name: "api" },
        number: 3,
        title: "PR 3",
        updatedAt: "2026-09-11T00:00:00Z",
      },
    ]);
    expect(listing.unavailable).toEqual([]);
  });

  it("1 つが読めなくても、他を出す（読めなかったことは残す）", async () => {
    // **実測の形**——**読めたものは返り、読めなかったものだけが `null` + `errors`**
    const { fetchImpl } = responding({
      data: { r0: box([{ number: 1 }]), r1: null, r2: box([{ number: 2 }]) },
      errors: [{ type: "NOT_FOUND", path: ["r1"], message: "Could not resolve …" }],
    });
    const source = createGitHubCrossRepositoryPullRequests({ fetchImpl });

    const listing = await source.list(TOKEN, [repo("web"), repo("secret"), repo("api")]);

    expect(
      listing.pullRequests.map((pr) => pr.number),
      "読めた側まで捨てている",
    ).toEqual([1, 2]);
    expect(listing.unavailable).toEqual([
      { repository: { owner: "acme", name: "secret" }, kind: "unreadable" },
    ]);
  });

  it("読めなかったリポジトリを「PR が 0 本」と読まない", async () => {
    // **`errors` を読み落とすと、`null` が「0 本」に化ける**
    const { fetchImpl } = responding({ data: { r0: null }, errors: [{ path: ["r0"] }] });
    const source = createGitHubCrossRepositoryPullRequests({ fetchImpl });

    const listing = await source.list(TOKEN, [repo("web")]);

    expect(listing.pullRequests).toEqual([]);
    expect(listing.unavailable, "読めなかったことが消えている").toHaveLength(1);
  });

  it("読み切れなかったリポジトリは、読めたぶんを出したうえで残す", async () => {
    // **「答えが返らなかった」と「多すぎて読み切れなかった」を分ける**
    // ——**混ぜると、一部だけ出ているのに「全部無い」と読まれる**
    const { fetchImpl } = responding({
      data: { r0: box([{ number: 1 }, { number: 2 }], 120) },
    });
    const source = createGitHubCrossRepositoryPullRequests({ fetchImpl });

    const listing = await source.list(TOKEN, [repo("web")]);

    expect(listing.pullRequests.map((pr) => pr.number)).toEqual([1, 2]);
    expect(listing.unavailable).toEqual([
      { repository: { owner: "acme", name: "web" }, kind: "truncated" },
    ]);
  });

  it("形の読めない 1 件で、その箱ごと捨てない", async () => {
    const { fetchImpl } = responding({
      data: {
        r0: {
          pullRequests: {
            totalCount: 2,
            nodes: [
              { number: 1, title: "読める", updatedAt: "2026-09-11T00:00:00Z" },
              { title: 9 },
            ],
          },
        },
      },
    });
    const source = createGitHubCrossRepositoryPullRequests({ fetchImpl });

    const listing = await source.list(TOKEN, [repo("web")]);

    expect(listing.pullRequests.map((pr) => pr.number)).toEqual([1]);
    expect(listing.invalid).toEqual([
      { repository: { owner: "acme", name: "web" }, index: 1, reason: expect.any(String) },
    ]);
  });

  it("1 往復で取れるものを、その 1 往復で全部取る", async () => {
    // **どれも同じ node の中にある**（#681）——**往復は増えない。**
    // **読めなかったものは持たない**（**「分からない」へ倒れる**）
    const { fetchImpl } = responding({
      data: {
        r0: {
          pullRequests: {
            totalCount: 1,
            nodes: [
              {
                number: 7,
                title: "図を出す",
                updatedAt: "2026-09-11T00:00:00Z",
                headRefOid: "abc1234",
                mergeable: "MERGEABLE",
                mergeStateStatus: "CLEAN",
                author: { __typename: "Bot", login: "dependabot" },
                assignees: { totalCount: 1, nodes: [{ login: "hana" }] },
                reviewRequests: {
                  totalCount: 1,
                  nodes: [{ requestedReviewer: { __typename: "User", login: "taro" } }],
                },
                reviews: { totalCount: 2 },
                latestOpinionatedReviews: {
                  pageInfo: { hasNextPage: false },
                  nodes: [{ state: "APPROVED", commit: { oid: "abc1234" } }],
                },
              },
            ],
          },
        },
      },
    });
    const source = createGitHubCrossRepositoryPullRequests({ fetchImpl });

    const [pullRequest] = (await source.list(TOKEN, [repo("web")])).pullRequests;

    expect(pullRequest?.head).toBe("abc1234");
    expect(pullRequest?.mergeStatus).toEqual({ mergeable: "mergeable", state: "clean" });
    expect(pullRequest?.opinion).toEqual({
      approvesHead: true,
      changesRequestedOnHead: false,
      reviewed: true,
    });
    expect(pullRequest?.assignment).toEqual({
      assignees: ["hana"],
      reviewers: ["taro"],
      authoredByBot: true,
    });
  });

  it("読めなかった材料は、持たない（分からない側へ倒す）", async () => {
    // **`ballOf` / `mergeReadinessOf` / `assignmentStateOf` が「分からない」へ倒す**
    // ——**持たせると「放置」「マージできる」「誰も持っていない」に化ける**
    const { fetchImpl } = responding({ data: { r0: box([{ number: 1 }]) } });
    const source = createGitHubCrossRepositoryPullRequests({ fetchImpl });

    const [pullRequest] = (await source.list(TOKEN, [repo("web")])).pullRequests;

    expect(pullRequest?.mergeStatus).toBeUndefined();
    expect(pullRequest?.opinion).toBeUndefined();
    expect(pullRequest?.assignment).toBeUndefined();
    expect(pullRequest?.head).toBeUndefined();
  });

  it("跨がないものを、この口から出さない", async () => {
    // **ファイル変更に依るもの（Tier・同じファイルを触る組）は「PR 1 本あたり 3 往復」の側**
    // ——**41 本で約 2 分**になる。**依存の辺も作らない**（**跨がない**。#662）
    const { sent, fetchImpl } = responding({ data: { r0: box([{ number: 1 }]) } });
    const source = createGitHubCrossRepositoryPullRequests({ fetchImpl });

    const listing = await source.list(TOKEN, [repo("web")]);

    const body = sent[0]?.body as { query: string };
    expect(body.query, "ファイル変更まで取りに行っている").not.toContain("files");
    expect(Object.keys(listing)).toEqual(["pullRequests", "unavailable", "invalid"]);
    expect(Object.keys(listing.pullRequests[0] ?? {}).sort()).toEqual([
      "number",
      "repository",
      "title",
      "updatedAt",
    ]);
  });

  it("Team へのレビュー依頼も、依頼として残す", async () => {
    // **User 専用の fragment だけだと、Team の依頼は `{}` で返る**（#685 のレビュー）
    // ——**そこで箱ごと落ちると、「依頼あり」が「読み取り不能」になる。**
    // **`Assignment.reviewers` は team の slug も含む**と決めてある
    const { fetchImpl } = responding({
      data: {
        r0: {
          pullRequests: {
            totalCount: 1,
            nodes: [
              {
                number: 1,
                title: "図を出す",
                updatedAt: "2026-09-11T00:00:00Z",
                author: { __typename: "User", login: "hana" },
                assignees: { totalCount: 0, nodes: [] },
                reviewRequests: {
                  totalCount: 2,
                  nodes: [
                    { requestedReviewer: { __typename: "User", login: "taro" } },
                    { requestedReviewer: { __typename: "Team", slug: "reviewers" } },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const source = createGitHubCrossRepositoryPullRequests({ fetchImpl });

    const [pullRequest] = (await source.list(TOKEN, [repo("web")])).pullRequests;

    expect(pullRequest?.assignment?.reviewers, "team の依頼が消えている").toEqual([
      "taro",
      "reviewers",
    ]);
  });

  it("login や slug を持つ依頼の型を、全部拾う", async () => {
    // **`RequestedReviewer` は 5 つある**（#685 のレビュー 2 周目。**introspection で数えた**）
    // ——**User / Bot / Mannequin が `login`、Team / EnterpriseTeam が `slug`**。
    // **拾い漏らすと `{}` が返り、アサインごと「読み取り不能」になる**
    const { sent, fetchImpl } = responding({ data: { r0: box([]) } });
    const source = createGitHubCrossRepositoryPullRequests({ fetchImpl });

    await source.list(TOKEN, [repo("web")]);

    const query = (sent[0]?.body as { query?: string } | undefined)?.query ?? "";
    for (const type of ["User", "Bot", "Mannequin", "Team", "EnterpriseTeam"]) {
      expect(query, `${type} への依頼が読めない`).toContain(`... on ${type}{`);
    }
  });

  it("知らない型の依頼が 1 件でもあれば、アサインを持たない", async () => {
    // **union はこれからも増える**（#685 のレビュー 2 周目）——**知らない型は `{}` で返る。**
    // **その 1 件を落として残りを返すと、依頼された人が黙って消える**
    // ——**切り捨てと同じ倒し方**にする（**分からない側**）
    const { fetchImpl } = responding({
      data: {
        r0: {
          pullRequests: {
            totalCount: 1,
            nodes: [
              {
                number: 1,
                title: "図を出す",
                updatedAt: "2026-09-11T00:00:00Z",
                author: { __typename: "User", login: "hana" },
                assignees: { totalCount: 0, nodes: [] },
                reviewRequests: {
                  totalCount: 2,
                  nodes: [
                    { requestedReviewer: { __typename: "User", login: "taro" } },
                    // **これから増える型**——**fragment が当たらないと `{}` が返る**
                    { requestedReviewer: {} },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const source = createGitHubCrossRepositoryPullRequests({ fetchImpl });

    const [pullRequest] = (await source.list(TOKEN, [repo("web")])).pullRequests;

    expect(pullRequest?.assignment, "知らない型を黙って落としている").toBeUndefined();
  });

  it("依頼が多すぎて読み切れなければ、分からない側へ倒す", async () => {
    // **`first:10` しか取っていない**（#685 のレビュー）——**そのまま返すと、
    // 11 人目以降が黙って消える。** **`assignmentNote` はこの配列をそのまま出す**
    const { fetchImpl } = responding({
      data: {
        r0: {
          pullRequests: {
            totalCount: 1,
            nodes: [
              {
                number: 1,
                title: "図を出す",
                updatedAt: "2026-09-11T00:00:00Z",
                author: { __typename: "User", login: "hana" },
                assignees: { totalCount: 0, nodes: [] },
                reviewRequests: {
                  totalCount: 11,
                  nodes: Array.from({ length: 10 }, (_, index) => ({
                    requestedReviewer: { __typename: "User", login: `reviewer-${index}` },
                  })),
                },
              },
            ],
          },
        },
      },
    });
    const source = createGitHubCrossRepositoryPullRequests({ fetchImpl });

    const [pullRequest] = (await source.list(TOKEN, [repo("web")])).pullRequests;

    expect(pullRequest?.assignment, "切り取った一覧を、全部だと見せている").toBeUndefined();
  });

  it("要求そのものが落ちた応答を、リポジトリごとの「読めなかった」にしない", async () => {
    // **HTTP 200 のまま `{errors:[…]}` で返ることがある**（#685 のレビュー）
    // ——**実測: `MAX_NODE_LIMIT_EXCEEDED` はこの形**である。
    // **呼ぶ側が「要求ごと落ちた」と「1 つだけ読めなかった」を区別できなくなる**
    const { fetchImpl } = responding({
      errors: [{ type: "MAX_NODE_LIMIT_EXCEEDED", message: "…exceeds the maximum limit…" }],
    });
    const source = createGitHubCrossRepositoryPullRequests({ fetchImpl });

    await expect(source.list(TOKEN, [repo("web"), repo("api")])).rejects.toThrow();
  });

  it("`data` が空でも、応答として読めていれば返す", async () => {
    // **上と区別する**——**`data` が在って中身が無いのは、聞かれていないだけ**である
    const { fetchImpl } = responding({ data: {} });
    const source = createGitHubCrossRepositoryPullRequests({ fetchImpl });

    const listing = await source.list(TOKEN, [repo("web")]);

    expect(listing.unavailable).toEqual([
      { repository: { owner: "acme", name: "web" }, kind: "unreadable" },
    ]);
  });

  it("owner / name を、問い合わせ本文へ埋め込まない", async () => {
    // **外から来る値である**（§3）——**変数で渡す**
    const { sent, fetchImpl } = responding({ data: { r0: box([]) } });
    const source = createGitHubCrossRepositoryPullRequests({ fetchImpl });

    await source.list(TOKEN, [repo('") { x } #')]);

    const body = sent[0]?.body as { query: string; variables: Record<string, unknown> };
    expect(body.query, "名前を本文へ埋め込んでいる").not.toContain('") { x } #');
    expect(Object.values(body.variables)).toContain('") { x } #');
  });

  it("その人の身元で引く", async () => {
    // **installation トークンで代用しない**（§6）——**誰がログインしていても同じものが見える**
    const { sent, fetchImpl } = responding({ data: { r0: box([]) } });
    const source = createGitHubCrossRepositoryPullRequests({ fetchImpl });

    await source.list(TOKEN, [repo("web")]);

    expect(sent[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("1 件も渡されなければ、叩かない", async () => {
    // **空の一覧で往復を作らない**
    const { sent, fetchImpl } = responding({ data: {} });
    const source = createGitHubCrossRepositoryPullRequests({ fetchImpl });

    const listing = await source.list(TOKEN, []);

    expect(sent).toHaveLength(0);
    expect(listing).toEqual({ pullRequests: [], unavailable: [], invalid: [] });
  });

  it("応答そのものが読めなければ、投げる", async () => {
    // **空の一覧を返すと、「読めなかった」が「1 本も open PR が無い」に化ける**
    const source = createGitHubCrossRepositoryPullRequests({
      fetchImpl: (async () =>
        ({
          ok: false,
          status: 502,
          json: async () => ({}),
        }) as unknown as Response) as unknown as typeof fetch,
    });

    await expect(source.list(TOKEN, [repo("web")])).rejects.toThrow(/502/);
  });

  it("応答の中身を、エラーに載せない", async () => {
    // **秘密が混ざりうる**（§6）
    const source = createGitHubCrossRepositoryPullRequests({
      fetchImpl: (async () =>
        ({
          ok: false,
          status: 500,
          json: async () => ({ message: "token ghp_secret is invalid" }),
        }) as unknown as Response) as unknown as typeof fetch,
    });

    await expect(source.list(TOKEN, [repo("web")])).rejects.toThrow(/^(?!.*ghp_secret).*$/s);
  });

  it("打ち切りの合図を、口まで通す", async () => {
    // **先に返すだけでは、走っている要求は走り続ける**
    let passed: AbortSignal | undefined;
    const source = createGitHubCrossRepositoryPullRequests({
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        passed = init?.signal ?? undefined;
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { r0: box([]) } }),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    const controller = new AbortController();

    await source.list(TOKEN, [repo("web")], { signal: controller.signal });

    expect(passed, "合図が口まで届いていない").toBe(controller.signal);
  });
});
