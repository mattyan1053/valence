/**
 * **1 つのリポジトリの盤面を出す前に、見てよいかを確かめる**（#314）。
 *
 * **この流れの本体は認可である。** **PR のデータを取るのは installation トークン**
 * だが、**あれは「リポジトリへの操作」**なので、**それだけで出すと、誰がログイン
 * していても同じものが見える**（`AGENTS.md` §6 が名指ししている誤り）。
 *
 * **見られないリポジトリでは、存在も漏らさない**——**「権限がありません」と
 * 「ありません」を区別できる形にしない。**
 *
 * **モックを使わない**（§4）——**port にインメモリ実装を渡す。**
 */

import { describe, expect, it } from "vitest";
import type { VisibleRepositories, VisibleRepositoryListing } from "../ports/visible-repositories";
import type { ReviewOrderPlan } from "./plan-review-order";
import { viewRepositoryBoard } from "./view-repository-board";

const TARGET = { owner: "acme", name: "web" } as const;

/** 空の盤面。**中身はこの流れの関心ではない**（作るのは `planReviewOrder`）。 */
const PLAN: ReviewOrderPlan = {
  pullRequests: [],
  edges: [],
  order: { ordered: [], cyclic: [] },
  invalid: [],
  changes: new Map(),
  changesUnavailable: [],
};

/** 見えるものを決められる一覧。**誰の目で見たか**を後から確かめる。 */
function repositories(listing: VisibleRepositoryListing): VisibleRepositories & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    async list(userAccessToken: string) {
      seen.push(userAccessToken);
      return listing;
    },
  };
}

/** 盤面を取りに行ったかどうか。**installation トークンを使う側**である。 */
function plan(): { run: () => Promise<ReviewOrderPlan>; calls: number } {
  const state = { calls: 0, run: async () => PLAN };
  state.run = async () => {
    state.calls += 1;
    return PLAN;
  };
  return state;
}

const VISIBLE: VisibleRepositoryListing = { repositories: [TARGET], invalid: [] };
const NOTHING_VISIBLE: VisibleRepositoryListing = { repositories: [], invalid: [] };

describe("リポジトリの盤面を出す前に、見てよいかを確かめる", () => {
  it("ログインしていなければ、PR のデータを取りに行かない", async () => {
    const listing = repositories(VISIBLE);
    const board = plan();

    const result = await viewRepositoryBoard({
      repository: TARGET,
      openStore: async () => undefined,
      ensure: async () => ({ kind: "usable", accessToken: "should-not-be-used" }),
      repositories: listing,
      plan: board.run,
    });

    expect(result).toEqual({ kind: "signed-out" });
    expect(board.calls, "ログインしていないのに PR を取りに行っている").toBe(0);
    expect(listing.seen, "誰の目でもないのに一覧を引いている").toEqual([]);
  });

  it("見られないリポジトリでは、PR のデータを 1 件も取りに行かない", async () => {
    // **`not-found` は「無い」とも「見えない」とも読める**——**そこが要点**である
    const listing = repositories(NOTHING_VISIBLE);
    const board = plan();

    const result = await viewRepositoryBoard({
      repository: TARGET,
      openStore: async () => ({}) as never,
      ensure: async () => ({ kind: "usable", accessToken: "user-token" }),
      repositories: listing,
      plan: board.run,
    });

    expect(result).toEqual({ kind: "not-found" });
    expect(board.calls, "見てよいか確かめる前に PR を取りに行っている").toBe(0);
  });

  it("見られるリポジトリなら、盤面を返す", async () => {
    const listing = repositories(VISIBLE);
    const board = plan();

    const result = await viewRepositoryBoard({
      repository: TARGET,
      openStore: async () => ({}) as never,
      ensure: async () => ({ kind: "usable", accessToken: "user-token" }),
      repositories: listing,
      plan: board.run,
    });

    expect(result).toEqual({ kind: "board", plan: PLAN });
    // **installation ではなく、その人のトークンで見えるかを判定している**
    expect(listing.seen).toEqual(["user-token"]);
    expect(board.calls).toBe(1);
  });

  it("大文字小文字が違うだけなら、同じリポジトリとして見る", async () => {
    // **GitHub の owner / name は大文字小文字を区別しない。** **ここで区別すると、
    // 見られる人が「ありません」を受け取る**——**厳しい側だが、誤りである**
    const listing = repositories({ repositories: [{ owner: "ACME", name: "Web" }], invalid: [] });
    const board = plan();

    const result = await viewRepositoryBoard({
      repository: TARGET,
      openStore: async () => ({}) as never,
      ensure: async () => ({ kind: "usable", accessToken: "user-token" }),
      repositories: listing,
      plan: board.run,
    });

    expect(result).toEqual({ kind: "board", plan: PLAN });
  });

  it("一覧を取れなかったら、「見えない」に化けさせない", async () => {
    // **投げたものを `not-found` へ倒すと、故障が「そんなリポジトリはありません」に
    // なる**——**入り直しても直らないほうへ倒す**（`unavailable`）
    const board = plan();

    const result = await viewRepositoryBoard({
      repository: TARGET,
      openStore: async () => ({}) as never,
      ensure: async () => ({ kind: "usable", accessToken: "user-token" }),
      repositories: {
        async list() {
          throw new Error("見られるリポジトリを取得できませんでした (HTTP 502)");
        },
      },
      plan: board.run,
    });

    expect(result).toEqual({ kind: "unavailable" });
    expect(board.calls, "確かめられていないのに PR を取りに行っている").toBe(0);
  });

  it("読めなかった行があるなら、「見えない」と言い切らない", async () => {
    // **判定不能を「無い」に倒さない**（§5）。**漏れはしない**——
    // **`unavailable` は対象が在るかどうかに関係なく返る**ので、**存在を教えない**
    const board = plan();

    const result = await viewRepositoryBoard({
      repository: TARGET,
      openStore: async () => ({}) as never,
      ensure: async () => ({ kind: "usable", accessToken: "user-token" }),
      repositories: repositories({
        repositories: [{ owner: "other", name: "repo" }],
        invalid: [{ index: 3, reason: "読めません" }],
      }),
      plan: board.run,
    });

    expect(result).toEqual({ kind: "unavailable" });
    expect(board.calls, "見えるか分からないのに PR を取りに行っている").toBe(0);
  });

  it("読めなかった行があっても、見えると分かればそのまま出す", async () => {
    // **抜けがあることと、この 1 件が見えることは別**である
    const board = plan();

    const result = await viewRepositoryBoard({
      repository: TARGET,
      openStore: async () => ({}) as never,
      ensure: async () => ({ kind: "usable", accessToken: "user-token" }),
      repositories: repositories({
        repositories: [TARGET],
        invalid: [{ index: 3, reason: "読めません" }],
      }),
      plan: board.run,
    });

    expect(result).toEqual({ kind: "board", plan: PLAN });
  });

  it.each([
    { kind: "needs-login" as const, expected: "needs-login" },
    { kind: "unavailable" as const, expected: "unavailable" },
  ])("トークンが $kind なら、そこで止まる", async ({ kind, expected }) => {
    const listing = repositories(VISIBLE);
    const board = plan();

    const result = await viewRepositoryBoard({
      repository: TARGET,
      openStore: async () => ({}) as never,
      ensure: async () => ({ kind }),
      repositories: listing,
      plan: board.run,
    });

    expect(result).toEqual({ kind: expected });
    expect(listing.seen, "使えないトークンで叩きに行っている").toEqual([]);
    expect(board.calls, "使えないトークンのまま PR を取りに行っている").toBe(0);
  });

  it("置き場を開けなかったら、期限切れと分ける", async () => {
    const board = plan();

    const result = await viewRepositoryBoard({
      repository: TARGET,
      openStore: async () => {
        throw new Error("置き場が落ちています");
      },
      ensure: async () => ({ kind: "usable", accessToken: "should-not-be-used" }),
      repositories: repositories(VISIBLE),
      plan: board.run,
    });

    expect(result).toEqual({ kind: "unavailable" });
    expect(board.calls).toBe(0);
  });
});
