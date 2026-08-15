/**
 * **そのリポジトリを、そのユーザーが触ってよいか**（#315）。
 *
 * **判断を 1 箇所に置く。** **#314 が盤面を出す前に確かめている手順と同じもの**を、
 * **Approve / Merge でも通す**——**写すと、片方だけ直したときに食い違う**
 * （`AGENTS.md` §5）。**認可が食い違ったときの症状は「他人のリポジトリを操作できる」**
 * なので、**2 箇所に持ってよい類のものではない。**
 *
 * **モックを使わない**（§4）——**port にインメモリ実装を渡す。**
 */

import { describe, expect, it } from "vitest";
import type { UserTokenStore } from "../ports/user-token-store";
import type { VisibleRepositories, VisibleRepositoryListing } from "../ports/visible-repositories";
import { authorizeRepository } from "./authorize-repository";
import type { UsableToken } from "./ensure-usable-token";

const TARGET = { owner: "acme", name: "web" } as const;
const VISIBLE: VisibleRepositoryListing = { repositories: [TARGET], invalid: [] };
const NOTHING_VISIBLE: VisibleRepositoryListing = { repositories: [], invalid: [] };

/** 置き場の中身はこの流れの関心ではない（使うのは `ensure` だけ）。 */
const STORE = {} as UserTokenStore;

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

function authorize(input: {
  readonly listing?: VisibleRepositoryListing;
  readonly usable?: UsableToken;
  readonly store?: UserTokenStore | undefined;
  readonly openStore?: () => Promise<UserTokenStore | undefined>;
  readonly listing_?: never;
  readonly seen?: string[];
}) {
  const visible = repositories(input.listing ?? VISIBLE);
  return {
    visible,
    run: () =>
      authorizeRepository({
        repository: TARGET,
        openStore: input.openStore ?? (async () => ("store" in input ? input.store : STORE)),
        ensure: async () => input.usable ?? { kind: "usable", accessToken: "user-token" },
        repositories: visible,
      }),
  };
}

describe("そのリポジトリを触ってよいか", () => {
  it("ログインしていなければ、一覧すら引かない", async () => {
    // **誰の権限も無い。** **引きに行くと、誰の目で見た結果かが決まらない**
    const { visible, run } = authorize({ store: undefined });

    expect(await run()).toEqual({ kind: "signed-out" });
    expect(visible.seen, "ログインしていないのに一覧を引いている").toEqual([]);
  });

  it("置き場を開けなかったら、見えないことにしない", async () => {
    // **故障を「権限が無い」へ倒さない**——**入り直しても直らない側**である
    const { run } = authorize({
      openStore: async () => {
        throw new Error("置き場が落ちている");
      },
    });

    expect(await run()).toEqual({ kind: "unavailable" });
  });

  it("失効していたら、入り直しへ送る", async () => {
    const { visible, run } = authorize({ usable: { kind: "needs-login" } });

    expect(await run()).toEqual({ kind: "needs-login" });
    expect(visible.seen, "使えないトークンで叩きに行っている").toEqual([]);
  });

  it("ユーザーの目で一覧を引く", async () => {
    // **installation トークンで代用しない**（§6）——**渡るのはユーザートークン**
    const { visible, run } = authorize({ usable: { kind: "usable", accessToken: "user-token" } });

    expect(await run()).toEqual({ kind: "authorized", userAccessToken: "user-token" });
    expect(visible.seen, "ユーザートークンで引いていない").toEqual(["user-token"]);
  });

  it("見えないリポジトリは、存在も漏らさない", async () => {
    // **「権限がありません」と「ありません」を区別できる応答にしない**（§6）
    const { run } = authorize({ listing: NOTHING_VISIBLE });

    expect(await run()).toEqual({ kind: "not-found" });
  });

  it("読めなかった行があるなら、「無い」と言い切らない", async () => {
    // **判定不能を「無い」へ倒さない**（§5）——**その中に居たかどうかを言えない。**
    // **漏れはしない**（`unavailable` は対象が在るかに関係なく返る）
    const { run } = authorize({
      listing: { repositories: [], invalid: [{ index: 2, reason: "name が無い" }] },
    });

    expect(await run()).toEqual({ kind: "unavailable" });
  });

  it("一覧が落ちたら、「ありません」に化けさせない", async () => {
    const failing: VisibleRepositories = {
      async list() {
        throw new Error("GitHub が落ちている");
      },
    };

    expect(
      await authorizeRepository({
        repository: TARGET,
        openStore: async () => STORE,
        ensure: async () => ({ kind: "usable", accessToken: "user-token" }),
        repositories: failing,
      }),
    ).toEqual({ kind: "unavailable" });
  });

  it("大文字小文字は区別しない", async () => {
    // **GitHub の owner / name は区別しない**ので、**ここで区別すると、
    // 見られる人が「ありません」を受け取る**
    const { run } = authorize({
      listing: { repositories: [{ owner: "ACME", name: "Web" }], invalid: [] },
    });

    expect((await run()).kind).toBe("authorized");
  });
});
