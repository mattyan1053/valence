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
import type {
  PullRequestApprovalListing,
  PullRequestApprovals,
} from "../ports/pull-request-approvals";
import type { RepositoryPermissions } from "../ports/repository-permissions";
import type { VisibleRepositories, VisibleRepositoryListing } from "../ports/visible-repositories";
import type { ReviewOrderPlan } from "./plan-review-order";
import { viewRepositoryBoard } from "./view-repository-board";

const TARGET = { owner: "acme", name: "web" } as const;

/** 盤面に 1 件だけ載る PR。**承認の状態は「どの番号か」で引く。** */
const PULL_REQUEST = {
  number: 7,
  base: { repository: "acme/web", branch: "main" },
  head: { repository: "acme/web", branch: "feat/a" },
} as const;

/** 空の盤面。**中身はこの流れの関心ではない**（作るのは `planReviewOrder`）。 */
const PLAN: ReviewOrderPlan = {
  pullRequests: [],
  edges: [],
  order: { ordered: [], cyclic: [] },
  invalid: [],
  heads: new Map(),
  changes: new Map(),
  changesUnavailable: [],
};

/** 承認の状態を 1 件も持たない盤面。**この流れの関心は「誰の目で読むか」**である。 */
const NO_APPROVALS: PullRequestApprovalListing = { approved: new Set(), unavailable: [] };

/**
 * 承認の状態を読む口（#343）。**誰のトークンで読んだか**を後から確かめる。
 *
 * **installation トークンで読むと、誰がログインしていても同じ答えになる**（§6）
 * ——**見たトークンを残しておかないと、差し替えても試験は黙る。**
 */
function approvals(
  listing: PullRequestApprovalListing = NO_APPROVALS,
): PullRequestApprovals & { seen: string[]; asked: number[][] } {
  const seen: string[] = [];
  const asked: number[][] = [];
  return {
    seen,
    asked,
    async listApprovals(userAccessToken, _repository, numbers) {
      seen.push(userAccessToken);
      asked.push([...numbers]);
      return listing;
    },
  };
}

/** 読めない口。**投げたものが「承認されていない」に化けないこと**を見る。 */
const APPROVALS_DOWN: PullRequestApprovals = {
  async listApprovals() {
    throw new Error("承認の状態を取得できませんでした (HTTP 502)");
  },
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

/**
 * **盤面では引かれない口** (#317 のレビュー)。**呼ばれたら落とす**——
 * **読むだけの経路が権限を引き始めたら、ここで気づく**（**read-only の人が
 * 見られなくなる変更**である）。
 */
const PERMISSIONS: RepositoryPermissions = {
  async levelFor() {
    throw new Error("盤面は権限の高さを引かない");
  },
};

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
      permissions: PERMISSIONS,
      plan: board.run,
      approvals: approvals(),
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
      permissions: PERMISSIONS,
      plan: board.run,
      approvals: approvals(),
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
      permissions: PERMISSIONS,
      plan: board.run,
      approvals: approvals(),
    });

    expect(result).toEqual({ kind: "board", plan: PLAN, approvals: NO_APPROVALS });
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
      permissions: PERMISSIONS,
      plan: board.run,
      approvals: approvals(),
    });

    expect(result).toEqual({ kind: "board", plan: PLAN, approvals: NO_APPROVALS });
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
      permissions: PERMISSIONS,
      plan: board.run,
      approvals: approvals(),
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
      permissions: PERMISSIONS,
      plan: board.run,
      approvals: approvals(),
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
      permissions: PERMISSIONS,
      plan: board.run,
      approvals: approvals(),
    });

    expect(result).toEqual({ kind: "board", plan: PLAN, approvals: NO_APPROVALS });
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
      permissions: PERMISSIONS,
      plan: board.run,
      approvals: approvals(),
    });

    expect(result).toEqual({ kind: expected });
    expect(listing.seen, "使えないトークンで叩きに行っている").toEqual([]);
    expect(board.calls, "使えないトークンのまま PR を取りに行っている").toBe(0);
  });

  it("盤面を取れなかったら、案内へ倒す", async () => {
    // **`planReviewOrder` は一覧を取れないと投げる**（**空の計画にすると
    // 「取得できなかった」が「PR が 0 件」に化ける**ため）——**そのまま通すと、
    // 見てよい人にまでフレームワークのエラー画面が出る**（#316 のレビュー）。
    // **用意してある「読み込み直してください」へ届かない。**
    const result = await viewRepositoryBoard({
      repository: TARGET,
      openStore: async () => ({}) as never,
      ensure: async () => ({ kind: "usable", accessToken: "user-token" }),
      repositories: repositories(VISIBLE),
      permissions: PERMISSIONS,
      plan: async () => {
        throw new Error("PR 一覧を取得できませんでした (HTTP 502)");
      },
      approvals: approvals(),
    });

    expect(result).toEqual({ kind: "unavailable" });
  });

  it("承認の状態も、その人のトークンで読む", async () => {
    // **installation トークンで読むと、誰がログインしていても同じ答えになる**（§6）
    // ——**「その人の目」で読んでいることを、見たトークンで確かめる**
    const reader = approvals({ approved: new Set([7]), unavailable: [] });

    const result = await viewRepositoryBoard({
      repository: TARGET,
      openStore: async () => ({}) as never,
      ensure: async () => ({ kind: "usable", accessToken: "user-token" }),
      repositories: repositories(VISIBLE),
      permissions: PERMISSIONS,
      plan: async () => ({ ...PLAN, pullRequests: [PULL_REQUEST] }),
      approvals: reader,
    });

    expect(result.kind).toBe("board");
    expect(reader.seen, "承認の状態を、その人以外のトークンで読んでいる").toEqual(["user-token"]);
    // **盤面に載っている PR の状態を読む**——**番号を渡していなければ、
    // 口は「どれの話か」を知らないまま答えることになる**
    expect(reader.asked).toEqual([[7]]);
    expect(result).toEqual({
      kind: "board",
      plan: { ...PLAN, pullRequests: [PULL_REQUEST] },
      approvals: { approved: new Set([7]), unavailable: [] },
    });
  });

  it("見てよいと分かるまで、承認の状態も読まない", async () => {
    // **読むだけでも往復は起きる**——**見えない人の要求で GitHub を叩かない**（§6）
    const reader = approvals();

    const result = await viewRepositoryBoard({
      repository: TARGET,
      openStore: async () => ({}) as never,
      ensure: async () => ({ kind: "usable", accessToken: "user-token" }),
      repositories: repositories(NOTHING_VISIBLE),
      permissions: PERMISSIONS,
      plan: plan().run,
      approvals: reader,
    });

    expect(result).toEqual({ kind: "not-found" });
    expect(reader.seen, "見えないのに承認の状態を読んでいる").toEqual([]);
  });

  it("承認の状態を読めなくても、盤面は出す", async () => {
    // **依存グラフだけでも交通整理の役に立つ**（`collectChanges` と同じ判断）
    // ——**状態が読めないことを理由に、画面ごと落とさない**
    const result = await viewRepositoryBoard({
      repository: TARGET,
      openStore: async () => ({}) as never,
      ensure: async () => ({ kind: "usable", accessToken: "user-token" }),
      repositories: repositories(VISIBLE),
      permissions: PERMISSIONS,
      plan: async () => ({ ...PLAN, pullRequests: [PULL_REQUEST] }),
      approvals: APPROVALS_DOWN,
    });

    expect(result.kind).toBe("board");
  });

  it("読めなかった状態を、「承認されていない」に化けさせない", async () => {
    // **これが本題である。** **`approved` から外すだけだと、画面では
    // 「承認されていない」と見分けが付かない**——**押した人はもう一度押す**
    // （**この Issue が消しに来た形そのもの**）。
    const result = await viewRepositoryBoard({
      repository: TARGET,
      openStore: async () => ({}) as never,
      ensure: async () => ({ kind: "usable", accessToken: "user-token" }),
      repositories: repositories(VISIBLE),
      permissions: PERMISSIONS,
      plan: async () => ({ ...PLAN, pullRequests: [PULL_REQUEST] }),
      approvals: APPROVALS_DOWN,
    });

    expect(result.kind === "board" ? [...result.approvals.approved] : "板ではない").toEqual([]);
    expect(
      result.kind === "board"
        ? result.approvals.unavailable.map((row) => row.pullRequestNumber)
        : [],
      "読めなかった PR が、どこにも残っていない",
    ).toEqual([7]);
  });

  it("PR が 1 件も無ければ、承認の状態を読みに行かない", async () => {
    // **空の一覧で往復を作らない**——**盤面に何も無いなら、読む状態も無い**
    const reader = approvals();

    await viewRepositoryBoard({
      repository: TARGET,
      openStore: async () => ({}) as never,
      ensure: async () => ({ kind: "usable", accessToken: "user-token" }),
      repositories: repositories(VISIBLE),
      permissions: PERMISSIONS,
      plan: plan().run,
      approvals: reader,
    });

    expect(reader.seen, "読むものが無いのに叩きに行っている").toEqual([]);
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
      permissions: PERMISSIONS,
      plan: board.run,
      approvals: approvals(),
    });

    expect(result).toEqual({ kind: "unavailable" });
    expect(board.calls).toBe(0);
  });
});
