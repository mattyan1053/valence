/**
 * **横断の盤面を、画面へ渡せる形にする**（#682）。
 *
 * **1 つが読めなくても、他を出す。** **ただし「読めなかった」は残す**
 * ——**口が返した形を、ここで捨てない**（#681）。
 *
 * **倒し分けは `listVisibleRepositories` と揃える**（ログインしていない / 入り直す /
 * 故障）——**行き先が違うものを 1 つにまとめない。**
 */

import { describe, expect, it } from "vitest";
import type { ResolvedVisibleRepositories } from "../auth/resolve-visible-repositories";
import type {
  CrossRepositoryListing,
  CrossRepositoryPullRequests,
} from "../ports/cross-repository-pull-requests";
import type { VisibleRepositoryListing } from "../ports/visible-repositories";
import type { ViewCrossRepositoryBoardInput } from "./view-cross-repository-board";
import { viewCrossRepositoryBoard } from "./view-cross-repository-board";

const VISIBLE: VisibleRepositoryListing = {
  repositories: [
    { owner: "acme", name: "web" },
    { owner: "acme", name: "api" },
  ],
  invalid: [],
};

const EMPTY: CrossRepositoryListing = { pullRequests: [], unavailable: [], invalid: [] };

function source(
  listing: CrossRepositoryListing = EMPTY,
): CrossRepositoryPullRequests & { asked: { token: string; count: number }[] } {
  const asked: { token: string; count: number }[] = [];
  return {
    asked,
    async list(userAccessToken, repositories) {
      asked.push({ token: userAccessToken, count: repositories.length });
      return listing;
    },
  };
}

const RESOLVED: ResolvedVisibleRepositories = {
  kind: "resolved",
  userAccessToken: "user-token",
  listing: VISIBLE,
};

function input(
  overrides: Partial<ViewCrossRepositoryBoardInput> = {},
): ViewCrossRepositoryBoardInput {
  return { resolved: RESOLVED, pullRequests: source(), ...overrides };
}

describe("viewCrossRepositoryBoard", () => {
  it("見えるリポジトリを、その人のトークンで引く", async () => {
    // **installation トークンで代用しない**（§6）——**誰がログインしていても
    // 同じものが見えてしまう**
    const asked = source();

    const result = await viewCrossRepositoryBoard(input({ pullRequests: asked }));

    expect(asked.asked).toEqual([{ token: "user-token", count: 2 }]);
    expect(result.kind).toBe("board");
  });

  it("口が返した形を、そのまま渡す", async () => {
    // **「読めなかった」を画面の手前で捨てない**（#681 / #682）
    const listing: CrossRepositoryListing = {
      pullRequests: [
        {
          repository: { owner: "acme", name: "web" },
          number: 1,
          title: "図を出す",
          updatedAt: "2026-09-11T00:00:00Z",
        },
      ],
      unavailable: [{ repository: { owner: "acme", name: "api" }, kind: "unreadable" }],
      invalid: [],
    };

    const result = await viewCrossRepositoryBoard(input({ pullRequests: source(listing) }));

    expect(result.kind === "board" && result.listing).toEqual(listing);
  });

  it("リポジトリの一覧に読めない行があれば、その数も渡す", async () => {
    // **「読めなかった」を数と一緒に残す**（§5）——**一覧の側で落ちたぶんは、
    // 横断の一覧にも出てこない**
    const result = await viewCrossRepositoryBoard(
      input({
        resolved: {
          ...RESOLVED,
          listing: {
            repositories: VISIBLE.repositories,
            invalid: [{ index: 2, reason: "形が違う" }],
          },
        },
      }),
    );

    expect(result.kind === "board" && result.unreadableRepositories).toBe(1);
  });

  it("ログインしていなければ、データを出さない", async () => {
    const asked = source();

    const result = await viewCrossRepositoryBoard(
      input({ resolved: { kind: "signed-out" }, pullRequests: asked }),
    );

    expect(result.kind).toBe("signed-out");
    expect(asked.asked, "ログインしていないのに引きに行っている").toEqual([]);
  });

  it("期限切れは、入り直してもらう", async () => {
    const result = await viewCrossRepositoryBoard(input({ resolved: { kind: "needs-login" } }));

    expect(result.kind).toBe("needs-login");
  });

  it("引けなかったことを、「1 本も無い」にしない", async () => {
    // **空の一覧を返すと、故障が「open PR が 0 本」に化ける**
    const down: CrossRepositoryPullRequests = {
      async list() {
        throw new Error("GitHub から横断の PR 一覧を取得できませんでした (HTTP 502)");
      },
    };

    const result = await viewCrossRepositoryBoard(input({ pullRequests: down }));

    expect(result.kind).toBe("unavailable");
    expect(result.kind === "unavailable" && result.reason, "落ちどころが残っていない").toMatch(
      /pull-requests\//,
    );
  });

  it("見えるリポジトリが 1 件も無ければ、叩かない", async () => {
    // **空の一覧で往復を作らない**（#681 の口と同じ判断）
    const asked = source();

    const result = await viewCrossRepositoryBoard(
      input({
        resolved: { ...RESOLVED, listing: { repositories: [], invalid: [] } },
        pullRequests: asked,
      }),
    );

    expect(asked.asked).toEqual([]);
    expect(result.kind === "board" && result.listing).toEqual(EMPTY);
  });

  it("打ち切りの合図を、口まで通す", async () => {
    // **先に返すだけでは、走っている要求は走り続ける**
    let passed: AbortSignal | undefined;
    const controller = new AbortController();

    await viewCrossRepositoryBoard(
      input({
        pullRequests: {
          async list(_token, _repositories, request) {
            passed = request?.signal;
            return EMPTY;
          },
        },
        deadline: () => controller.signal,
      }),
    );

    expect(passed).toBe(controller.signal);
  });
});
