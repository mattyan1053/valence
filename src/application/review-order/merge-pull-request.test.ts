/**
 * **PR をマージする前に、押してよいかを確かめる**（#331。**#315 の 3/3**）。
 *
 * **2/3（#330）と同じ土台を使う**——**認可を 2 通り持たない。**
 * **違うのは操作だけ**で、**`require: "write"` を渡すところまで同じ**である。
 *
 * **マージできない理由をこちらで数え直さない。** **GitHub の答えを受けて分ける**
 * ——**規則を写すと、写した側が古くなる**（#330 で自己承認について選んだのと同じ）。
 *
 * **モックを使わない**（§4）——**port にインメモリ実装を渡す。**
 */

import { describe, expect, it } from "vitest";
import type { PullRequestRef } from "../../domain/graph/dependency-graph";
import type { PullRequestMerges, PullRequestMergeTarget } from "../ports/pull-request-merge";
import type { PullRequestSource } from "../ports/pull-request-source";
import type { RepositoryAccessLevel, RepositoryPermissions } from "../ports/repository-permissions";
import type { VisibleRepositories, VisibleRepositoryListing } from "../ports/visible-repositories";
import { mergePullRequest } from "./merge-pull-request";

const TARGET = { owner: "acme", name: "web" } as const;
const NUMBER = 42;
const HEAD_SHA = "5e2a91c4d7f60b83ae15cd429f70b6d8e3a142cb";

const VISIBLE: VisibleRepositoryListing = { repositories: [TARGET], invalid: [] };
const NOTHING_VISIBLE: VisibleRepositoryListing = { repositories: [], invalid: [] };

const USER_TOKEN = "user-token";

function repositories(listing: VisibleRepositoryListing): VisibleRepositories {
  return {
    async list() {
      return listing;
    },
  };
}

function permissions(level: RepositoryAccessLevel): RepositoryPermissions {
  return {
    async levelFor() {
      return level;
    },
  };
}

/** マージの口。**誰の身元で・どの PR を**マージしたかを控える。 */
function merges(
  outcome: "merged" | "not-mergeable" = "merged",
): PullRequestMerges & { calls: { token: string; target: PullRequestMergeTarget }[] } {
  const calls: { token: string; target: PullRequestMergeTarget }[] = [];
  return {
    calls,
    async merge(userAccessToken: string, target: PullRequestMergeTarget) {
      calls.push({ token: userAccessToken, target });
      return { kind: outcome };
    },
  };
}

function ref(number: number, base: string, head: string): PullRequestRef {
  return {
    number,
    base: { repository: "r", branch: base },
    head: { repository: "r", branch: head },
  };
}

/** いまの一覧を返す口。**押した時点の依存を見るため**である（#345）。 */
function listing(
  pullRequests: readonly PullRequestRef[],
  invalid: readonly { index: number; reason: string }[] = [],
): PullRequestSource {
  return {
    async listPullRequests() {
      return { pullRequests, invalid, heads: new Map() };
    },
  };
}

/** 依存の無い 1 本（#42 は main の上）。 */
const ALONE = [ref(NUMBER, "main", "feat/x")];

/** **呼ばれたら落とす口。** **確かめる前に GitHub を変えていないか**を見る。 */
const NEVER_MERGES: PullRequestMerges = {
  async merge() {
    throw new Error("押してよいと分かる前にマージした");
  },
};

function input(overrides: {
  readonly openStore?: () => Promise<undefined>;
  readonly listing?: VisibleRepositoryListing;
  readonly permissions: RepositoryPermissions;
  readonly merges: PullRequestMerges;
  readonly pullRequests?: PullRequestSource;
}) {
  return {
    repository: TARGET,
    number: NUMBER,
    headSha: HEAD_SHA,
    openStore: overrides.openStore ?? (async () => ({}) as never),
    ensure: async () => ({ kind: "usable", accessToken: USER_TOKEN }) as const,
    repositories: repositories(overrides.listing ?? VISIBLE),
    permissions: overrides.permissions,
    merges: overrides.merges,
    pullRequests: overrides.pullRequests ?? listing(ALONE),
  };
}

describe("PR をマージする前に、押してよいかを確かめる", () => {
  it("write を持たない人が押しても、マージされない", async () => {
    // **完了条件そのもの**（#331）。**「見える」だけでは足りない**
    const result = await mergePullRequest(
      input({ permissions: permissions("read"), merges: NEVER_MERGES }),
    );

    expect(result.kind).toBe("forbidden");
  });

  it("admin / write の人はマージできる", async () => {
    for (const level of ["admin", "write"] as const) {
      const merge = merges();

      const result = await mergePullRequest(
        input({ permissions: permissions(level), merges: merge }),
      );

      expect(result.kind, level).toBe("merged");
      expect(merge.calls.length, level).toBe(1);
    }
  });

  it("マージは、押した人の身元で行う", async () => {
    // **installation トークンで実行すると、保護ルールの「マージできる人」を
    // 迂回できる**（#330 で人が決めた条件と同じ形）
    const merge = merges();

    await mergePullRequest(input({ permissions: permissions("write"), merges: merge }));

    expect(merge.calls[0]?.token).toBe(USER_TOKEN);
    expect(merge.calls[0]?.target).toEqual({
      repository: TARGET,
      number: NUMBER,
      // **見せた head をそのまま運ぶ**（#331 のレビュー）——**途中で作り直さない**
      headSha: HEAD_SHA,
    });
  });

  it("いまマージできないことを、そのまま伝える", async () => {
    // **「押せたのに何も起きない」を作らない**（#331 の完了条件）
    const result = await mergePullRequest(
      input({ permissions: permissions("write"), merges: merges("not-mergeable") }),
    );

    expect(result.kind).toBe("not-mergeable");
  });

  it("ログインしていなければ、マージしに行かない", async () => {
    const result = await mergePullRequest(
      input({
        openStore: async () => undefined,
        permissions: permissions("write"),
        merges: NEVER_MERGES,
      }),
    );

    expect(result.kind).toBe("signed-out");
  });

  it("見えないリポジトリでは、存在も漏らさない", async () => {
    const result = await mergePullRequest(
      input({
        listing: NOTHING_VISIBLE,
        permissions: permissions("write"),
        merges: NEVER_MERGES,
      }),
    );

    expect(result.kind).toBe("not-found");
  });

  it("権限を引けなかったら、マージしに行かない", async () => {
    // **判定不能を「許す」へ倒さない。** **マージは取り消せない**
    const failing: RepositoryPermissions = {
      async levelFor() {
        throw new Error("引けない");
      },
    };

    const result = await mergePullRequest(input({ permissions: failing, merges: NEVER_MERGES }));

    expect(result.kind).toBe("unavailable");
  });

  it("マージそのものが落ちたら、成功と言わない", async () => {
    const throwing: PullRequestMerges = {
      async merge() {
        throw new Error("GitHub が返さない");
      },
    };

    const result = await mergePullRequest(
      input({ permissions: permissions("write"), merges: throwing }),
    );

    expect(result.kind).toBe("unavailable");
  });
});

describe("依存が残っている PR はマージしない", () => {
  // **依存グラフを描く道具が、依存を壊せるボタンを持っていた**（#345）——
  // **上段を先に入れると、土台のブランチに未確認の変更が混ざる**
  const STACK = [ref(8, "main", "feat/a"), ref(NUMBER, "feat/a", "feat/b")];

  it("土台が残っていれば、マージしに行かない", async () => {
    const result = await mergePullRequest(
      input({
        permissions: permissions("write"),
        merges: NEVER_MERGES,
        pullRequests: listing(STACK),
      }),
    );

    expect(result).toEqual({ kind: "dependency-pending", blockedBy: [8] });
  });

  it("依存が無ければ、これまでどおりマージできる", async () => {
    const merge = merges();

    const result = await mergePullRequest(
      input({ permissions: permissions("write"), merges: merge, pullRequests: listing(ALONE) }),
    );

    expect(result.kind).toBe("merged");
    expect(merge.calls.length).toBe(1);
  });

  it("循環していればマージしに行かない", async () => {
    const cycle = [ref(NUMBER, "feat/b", "feat/a"), ref(8, "feat/a", "feat/b")];

    const result = await mergePullRequest(
      input({
        permissions: permissions("write"),
        merges: NEVER_MERGES,
        pullRequests: listing(cycle),
      }),
    );

    expect(result).toEqual({ kind: "not-orderable" });
  });

  it("一覧を読めなければマージしない", async () => {
    // **確かめられないまま通すと、この Issue が塞ごうとしたものがそのまま通る**
    const failing: PullRequestSource = {
      async listPullRequests() {
        throw new Error("読めない");
      },
    };

    const result = await mergePullRequest(
      input({ permissions: permissions("write"), merges: NEVER_MERGES, pullRequests: failing }),
    );

    expect(result.kind).toBe("unavailable");
  });

  it("押してよいと分かる前に、一覧を読みに行かない", async () => {
    // **認可が先**（#314 / #317 と同じ順序）——**権限の無い人の要求で
    // GitHub を叩かない**
    const throwing: PullRequestSource = {
      async listPullRequests() {
        throw new Error("認可より先に読んだ");
      },
    };

    const result = await mergePullRequest(
      input({ permissions: permissions("read"), merges: NEVER_MERGES, pullRequests: throwing }),
    );

    expect(result.kind).toBe("forbidden");
  });
});

describe("読めなかった PR がある一覧では、マージしない", () => {
  // **`PullRequestSource` は検証に落ちた PR を `invalid` に残して正常終了する**
  // （#348 のレビュー）——**投げないので `catch` に入らず**、
  // **土台だけが読めなかった場合、上段が「依存なし」に見えてマージされる。**
  it("依存なしに見えても、読めなかった PR があればマージ要求が出ない", async () => {
    // **`pullRequests` の側は正常なまま**にしてある——**`invalid` が効いて
    // 赤くなったことを、依存の判定と分けて見るため**（master の指示）
    const merge = merges();

    const result = await mergePullRequest(
      input({
        permissions: permissions("write"),
        merges: merge,
        pullRequests: listing(ALONE, [{ index: 3, reason: "読めない" }]),
      }),
    );

    expect(merge.calls.length, "マージを要求している").toBe(0);
    expect(result).toEqual({ kind: "not-orderable" });
  });

  it("同じ一覧でも、読めなかった PR が無ければマージできる", async () => {
    // **上の 1 件が `invalid` だけで赤くなっていることを、ここが支えている**
    const merge = merges();

    const result = await mergePullRequest(
      input({ permissions: permissions("write"), merges: merge, pullRequests: listing(ALONE) }),
    );

    expect(result.kind).toBe("merged");
    expect(merge.calls.length).toBe(1);
  });
});
