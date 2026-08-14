/**
 * **画面へ出す前に、3 つへ倒し分ける**（#213 の完了条件）。
 *
 *   **ログインしていない** … リポジトリのデータを出さない
 *   **失効しているが更新できた** … 出る（#209 の経路が画面まで届く）
 *   **更新にも失敗した** … ログインへ戻す（**「何も見えない画面」で終わらせない**）
 *
 * **モックを使わない**（`AGENTS.md` §4）——**port にインメモリ実装を渡す。**
 */

import { describe, expect, it } from "vitest";
import type { UsableToken } from "../auth/ensure-usable-token";
import type { VisibleRepositories } from "../ports/visible-repositories";
import { listVisibleRepositories } from "./list-visible-repositories";

/** 渡されたトークンを覚えるだけの一覧。**誰の目で見たか**を後から確かめる。 */
function repositories(): VisibleRepositories & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    async list(userAccessToken: string) {
      seen.push(userAccessToken);
      return { repositories: [{ owner: "acme", name: "web" }], invalid: [] };
    },
  };
}

describe("見られるリポジトリを画面へ渡す", () => {
  it("ログインしていなければ、データを出さない", async () => {
    // **§6 の「閲覧権限を持つリポジトリのデータしか返さない」。**
    // **ログインしていない人には、誰の権限も無い**
    const listing = repositories();

    const result = await listVisibleRepositories({
      openStore: async () => undefined,
      ensure: async () => ({ kind: "usable", accessToken: "should-not-be-used" }),
      repositories: listing,
    });

    expect(result).toEqual({ kind: "signed-out" });
    expect(listing.seen, "ログインしていないのに一覧を取りに行っている").toEqual([]);
  });

  it("使えるトークンで解決する", async () => {
    const listing = repositories();

    const result = await listVisibleRepositories({
      openStore: async () => ({}) as never,
      ensure: async () => ({ kind: "usable", accessToken: "user-token" }),
      repositories: listing,
    });

    expect(result).toEqual({
      kind: "listed",
      listing: { repositories: [{ owner: "acme", name: "web" }], invalid: [] },
    });
    // **installation ではなく、その人のトークンで見ている**
    expect(listing.seen).toEqual(["user-token"]);
  });

  it("更新にも失敗したら、ログインへ戻す", async () => {
    // **「何も見えない画面」で終わらせない**（#213 の完了条件）
    const listing = repositories();

    const result = await listVisibleRepositories({
      openStore: async () => ({}) as never,
      ensure: async (): Promise<UsableToken> => ({ kind: "needs-login" }),
      repositories: listing,
    });

    expect(result).toEqual({ kind: "needs-login" });
    expect(listing.seen, "使えないトークンで叩きに行っている").toEqual([]);
  });

  it("読み書きに失敗したときも、期限切れと区別する", async () => {
    // **開けたあとに落ちる経路が残っていた** (#214)——**`ensure` の中で
    // 置き場が読めなかった場合**である。**開ける前だけを見ていたので、
    // ここは `needs-login` に化けていた**（**入り直しても直らない**）。
    const listing = repositories();

    const result = await listVisibleRepositories({
      openStore: async () => ({}) as never,
      ensure: async (): Promise<UsableToken> => ({ kind: "unavailable" }),
      repositories: listing,
    });

    expect(result).toEqual({ kind: "unavailable" });
    expect(listing.seen, "使えないトークンで叩きに行っている").toEqual([]);
  });

  it("置き場を開けなかったら、期限切れと区別する", async () => {
    // **「開けなかった」を「1 件も見えない」に化けさせない**——
    // **静かに空を出すと、ログインしているのに何も見えない画面が正常に見える。**
    //
    // **再ログインへ案内しない** (#213 のレビュー)——**置き場の障害は入り直しても
    // 直らない**ので、**「期限が切れました」と出すと、直らない故障を認証切れとして隠す。**
    const listing = repositories();

    const result = await listVisibleRepositories({
      openStore: async () => {
        throw new Error("開けません");
      },
      ensure: async () => ({ kind: "usable", accessToken: "user-token" }),
      repositories: listing,
    });

    expect(result).toEqual({ kind: "unavailable" });
    expect(listing.seen).toEqual([]);
  });
});
