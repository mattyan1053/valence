/**
 * **PR に承認を出す前に、押してよいかを確かめる**（#330）。
 *
 * **この流れの本体は身元である。** **#314 / #317 が置いた順序——
 * ユーザートークンで確かめてから動く——をそのまま通す**が、
 * **Approve は書き込みなので `require: "write"` を渡す**（**盤面は `read` のまま**）。
 *
 * **承認そのものも、押した人の身元で出す。** **installation トークンで出すと、
 * 本人には出せない承認（自己承認・保護ルールへの計上）が出せてしまう**
 * ——**人の判断で持ち越された条件**である（#317 → #330）。
 *
 * **モックを使わない**（§4）——**port にインメモリ実装を渡す。**
 */

import { describe, expect, it } from "vitest";
import type { PullRequestReviews, PullRequestReviewTarget } from "../ports/pull-request-review";
import type { RepositoryAccessLevel, RepositoryPermissions } from "../ports/repository-permissions";
import type { VisibleRepositories, VisibleRepositoryListing } from "../ports/visible-repositories";
import { approvePullRequest } from "./approve-pull-request";

const TARGET = { owner: "acme", name: "web" } as const;
const NUMBER = 42;

const VISIBLE: VisibleRepositoryListing = { repositories: [TARGET], invalid: [] };
const NOTHING_VISIBLE: VisibleRepositoryListing = { repositories: [], invalid: [] };

const USER_TOKEN = "user-token";

/** 見えるものを決められる一覧。**誰の目で見たか**を後から確かめる。 */
function repositories(listing: VisibleRepositoryListing): VisibleRepositories {
  return {
    async list() {
      return listing;
    },
  };
}

/** その人の権限の高さ。**引かれたかどうか**も見る。 */
function permissions(level: RepositoryAccessLevel): RepositoryPermissions & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    async levelFor(userAccessToken: string) {
      seen.push(userAccessToken);
      return level;
    },
  };
}

/** 承認の口。**誰の身元で・どの PR に出したか**を控える。 */
function reviews(
  outcome: "approved" | "self-approval" = "approved",
): PullRequestReviews & { calls: { token: string; target: PullRequestReviewTarget }[] } {
  const calls: { token: string; target: PullRequestReviewTarget }[] = [];
  return {
    calls,
    async approve(userAccessToken: string, target: PullRequestReviewTarget) {
      calls.push({ token: userAccessToken, target });
      return { kind: outcome };
    },
  };
}

/** **呼ばれたら落とす口。** **確かめる前に GitHub を変えていないか**を見る。 */
const NEVER_APPROVES: PullRequestReviews = {
  async approve() {
    throw new Error("押してよいと分かる前に承認を出した");
  },
};

function input(overrides: {
  readonly openStore?: () => Promise<undefined>;
  readonly listing?: VisibleRepositoryListing;
  readonly permissions: RepositoryPermissions;
  readonly reviews: PullRequestReviews;
}) {
  return {
    repository: TARGET,
    number: NUMBER,
    openStore: overrides.openStore ?? (async () => ({}) as never),
    ensure: async () => ({ kind: "usable", accessToken: USER_TOKEN }) as const,
    repositories: repositories(overrides.listing ?? VISIBLE),
    permissions: overrides.permissions,
    reviews: overrides.reviews,
  };
}

describe("PR に承認を出す前に、押してよいかを確かめる", () => {
  it("write を持たない人が押しても、承認は出ない", async () => {
    // **完了条件そのもの**（#330）。**「見える」だけでは足りない**——
    // **read-only の人も見えるので、そのまま通すと権限が上がる**
    const permission = permissions("read");

    const result = await approvePullRequest(
      input({ permissions: permission, reviews: NEVER_APPROVES }),
    );

    expect(result.kind).toBe("forbidden");
  });

  it("admin / write の人は承認できる", async () => {
    for (const level of ["admin", "write"] as const) {
      const review = reviews();

      const result = await approvePullRequest(
        input({ permissions: permissions(level), reviews: review }),
      );

      expect(result.kind, level).toBe("approved");
      expect(review.calls.length, level).toBe(1);
    }
  });

  it("承認は、押した人の身元で出す", async () => {
    // **installation トークンで出すと、本人には出せない承認が出せてしまう**
    // （#317 → #330 で人が持ち越した条件）——**渡すのはユーザートークンである**
    const review = reviews();

    await approvePullRequest(input({ permissions: permissions("write"), reviews: review }));

    expect(review.calls[0]?.token).toBe(USER_TOKEN);
    expect(review.calls[0]?.target).toEqual({ repository: TARGET, number: NUMBER });
  });

  it("自分の PR は自分で承認できない、と伝える", async () => {
    // **GitHub が弾いたことを、そのまま伝える**——**故障として出すと、
    // 読み込み直せば直ると誤解される**（#330 の「理由が伝わること」）
    const result = await approvePullRequest(
      input({ permissions: permissions("write"), reviews: reviews("self-approval") }),
    );

    expect(result.kind).toBe("self-approval");
  });

  it("ログインしていなければ、承認を出しに行かない", async () => {
    const result = await approvePullRequest(
      input({
        openStore: async () => undefined,
        permissions: permissions("write"),
        reviews: NEVER_APPROVES,
      }),
    );

    expect(result.kind).toBe("signed-out");
  });

  it("見えないリポジトリでは、存在も漏らさない", async () => {
    // **「権限がありません」と「ありません」を区別できる応答にしない**（§6）
    const result = await approvePullRequest(
      input({
        listing: NOTHING_VISIBLE,
        permissions: permissions("write"),
        reviews: NEVER_APPROVES,
      }),
    );

    expect(result.kind).toBe("not-found");
  });

  it("権限を引けなかったら、承認を出しに行かない", async () => {
    // **判定不能を「許す」へ倒さない。** **書き込みは取り消せない**
    const failing: RepositoryPermissions = {
      async levelFor() {
        throw new Error("引けない");
      },
    };

    const result = await approvePullRequest(
      input({ permissions: failing, reviews: NEVER_APPROVES }),
    );

    expect(result).toEqual({ kind: "unavailable", reason: "permissions/Error" });
  });

  it("承認そのものが落ちたら、成功と言わない", async () => {
    // **投げたものを「押せた」に化けさせない**——**押していないのに
    // 「承認しました」と出ると、誰も気づけない**
    const throwing: PullRequestReviews = {
      async approve() {
        throw new Error("GitHub が返さない");
      },
    };

    const result = await approvePullRequest(
      input({ permissions: permissions("write"), reviews: throwing }),
    );

    // **どこで落ちたかまで残す** (#506 の 2-b)——**`unavailable` だけでは、
    // 押せない理由が誰にも分からない**（**中身は出さない**。§6）
    expect(result).toEqual({ kind: "unavailable", reason: "approve/Error" });
  });
});
