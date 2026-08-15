/**
 * **Approve は、押してよいと分かってから出す**（#315）。
 *
 * **ここが守るのは順序である。** **installation トークンだけで実行すると、
 * ログインしていれば誰でも他人のリポジトリへ Approve を出せる**——
 * **`AGENTS.md` §6 が名指ししている誤りの、書き込み版**である。
 *
 * **「確かめてから」は、手続きごと受けることで担保する**——**結果を受け取る形にすると、
 * 確かめる前に GitHub が変わる。** **試験は「呼ばれた回数」で見る**（#314 と同じ形）。
 *
 * **モックを使わない**（§4）——**port にインメモリ実装を渡す。**
 */

import { describe, expect, it } from "vitest";
import type { UsableToken } from "../auth/ensure-usable-token";
import type { ReviewOutcome, ReviewRefusal } from "../ports/pull-request-review";
import type { UserTokenStore } from "../ports/user-token-store";
import type { VisibleRepositories, VisibleRepositoryListing } from "../ports/visible-repositories";
import { approvePullRequest } from "./approve-pull-request";

const TARGET = { owner: "acme", name: "web" } as const;
const VISIBLE: VisibleRepositoryListing = { repositories: [TARGET], invalid: [] };
const NOTHING_VISIBLE: VisibleRepositoryListing = { repositories: [], invalid: [] };
const STORE = {} as UserTokenStore;

function repositories(listing: VisibleRepositoryListing): VisibleRepositories {
  return {
    async list() {
      return listing;
    },
  };
}

/** Approve を出しに行ったかどうか。**installation トークンを使う側**である。 */
function approver(outcome: ReviewOutcome | (() => Promise<never>)) {
  const state = {
    calls: 0,
    approve: async (): Promise<ReviewOutcome> => {
      state.calls += 1;
      if (typeof outcome === "function") {
        return outcome();
      }
      return outcome;
    },
  };
  return state;
}

function run(input: {
  readonly listing?: VisibleRepositoryListing;
  readonly usable?: UsableToken;
  readonly store?: UserTokenStore | undefined;
  readonly outcome?: ReviewOutcome | (() => Promise<never>);
}) {
  const approve = approver(input.outcome ?? { kind: "approved" });
  return {
    approve,
    result: approvePullRequest({
      repository: TARGET,
      pullRequestNumber: 7,
      openStore: async () => ("store" in input ? input.store : STORE),
      ensure: async () => input.usable ?? { kind: "usable", accessToken: "user-token" },
      repositories: repositories(input.listing ?? VISIBLE),
      approve: () => approve.approve(),
    }),
  };
}

describe("Approve は、押してよいと分かってから出す", () => {
  it("ログインしていなければ、GitHub を変えない", async () => {
    const { approve, result } = run({ store: undefined });

    expect(await result).toEqual({ kind: "signed-out" });
    expect(approve.calls, "ログインしていないのに Approve を出している").toBe(0);
  });

  it("失効していたら、GitHub を変えない", async () => {
    const { approve, result } = run({ usable: { kind: "needs-login" } });

    expect(await result).toEqual({ kind: "needs-login" });
    expect(approve.calls, "使えないトークンのまま Approve を出している").toBe(0);
  });

  it("見えないリポジトリでは、GitHub を変えない", async () => {
    // **installation トークンだけで判定していないこと**（完了条件）——
    // **ここが通ると、ログインしていれば誰でも他人のリポジトリを Approve できる**
    const { approve, result } = run({ listing: NOTHING_VISIBLE });

    expect(await result).toEqual({ kind: "not-found" });
    expect(approve.calls, "権限が無いのに Approve を出している").toBe(0);
  });

  it("読めなかった行があるなら、押させない", async () => {
    // **判定不能を「触ってよい」へ倒さない**（§5）。**書き込みなので、
    // 倒れる向きを間違えると取り返せない**
    const { approve, result } = run({
      listing: { repositories: [], invalid: [{ index: 1, reason: "owner が無い" }] },
    });

    expect(await result).toEqual({ kind: "unavailable" });
    expect(approve.calls, "判定できないのに Approve を出している").toBe(0);
  });

  it("見えるリポジトリなら、Approve を出す", async () => {
    const { approve, result } = run({});

    expect(await result).toEqual({ kind: "approved" });
    expect(approve.calls, "確かめたのに出していない").toBe(1);
  });

  it.each<ReviewRefusal>(["not-permitted", "not-reviewable", "gone", "unavailable"])(
    "断られた理由（%s）を、そのまま押した人へ返す",
    async (reason) => {
      // **握りつぶさない**（完了条件）。**「押したが何も起きなかった」に見えると、
      // 押した人はもう一度押す**——**理由ごとにできることが違う**
      const { result } = run({ outcome: { kind: "refused", reason } });

      expect(await result).toEqual({ kind: "refused", reason });
    },
  );

  it("Approve が投げたら、成功にしない", async () => {
    // **port は断りを値で返す約束**だが、**約束を破る実装もありうる**——
    // **そのまま抜けると、押した人にはフレームワークのエラー画面が出る**
    // （#316 で実際に踏んだ形）
    const { result } = run({
      outcome: async () => {
        throw new Error("通信が切れた");
      },
    });

    expect(await result).toEqual({ kind: "refused", reason: "unavailable" });
  });
});
