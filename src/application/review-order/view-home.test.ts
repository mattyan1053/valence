/**
 * **入口の画面は、見えるリポジトリを 1 度だけ引く**（#686 のレビュー）。
 *
 * **`/` は 2 つのものを出す**（見えるリポジトリの一覧と、横断の盤面）が、
 * **どちらも同じ `/user/repos` を要る**——**別々に呼ぶと、100 件を超える
 * アカウントでは全ページが二重**になる（**1 往復 1.3 秒**の実測がそのまま 2 倍）。
 */

import { describe, expect, it } from "vitest";
import type { ResolvedVisibleRepositories } from "../auth/resolve-visible-repositories";
import type { CrossRepositoryPullRequests } from "../ports/cross-repository-pull-requests";
import { viewHome } from "./view-home";

const RESOLVED: ResolvedVisibleRepositories = {
  kind: "resolved",
  userAccessToken: "user-token",
  listing: { repositories: [{ owner: "acme", name: "web" }], invalid: [] },
};

function source(): CrossRepositoryPullRequests & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async list(userAccessToken) {
      asked.push(userAccessToken);
      return { pullRequests: [], unavailable: [], invalid: [] };
    },
  };
}

describe("viewHome", () => {
  it("見えるリポジトリを、1 度だけ引く", async () => {
    // **2 度引くと、いちばん重い部分がそのまま 2 倍**になる
    let resolved = 0;

    await viewHome({
      resolve: async () => {
        resolved += 1;
        return RESOLVED;
      },
      pullRequests: source(),
    });

    expect(resolved, "同じ一覧を 2 度引いている").toBe(1);
  });

  it("引いた 1 つを、両方へ渡す", async () => {
    const asked = source();

    const home = await viewHome({ resolve: async () => RESOLVED, pullRequests: asked });

    expect(home.repositories).toEqual({ kind: "listed", listing: RESOLVED.listing });
    expect(home.cross.kind).toBe("board");
    expect(asked.asked, "その人のトークンで引いていない").toEqual(["user-token"]);
  });

  it("ログインしていなければ、どちらも出さない", async () => {
    const asked = source();

    const home = await viewHome({
      resolve: async () => ({ kind: "signed-out" }),
      pullRequests: asked,
    });

    expect(home.repositories.kind).toBe("signed-out");
    expect(home.cross.kind).toBe("signed-out");
    expect(asked.asked, "ログインしていないのに引きに行っている").toEqual([]);
  });

  it("引けなかったときも、両方が同じ行き先へ倒れる", async () => {
    const home = await viewHome({
      resolve: async () => ({ kind: "unavailable", reason: "store/Error" }),
      pullRequests: source(),
    });

    expect(home.repositories.kind).toBe("unavailable");
    expect(home.cross.kind).toBe("unavailable");
  });
});
