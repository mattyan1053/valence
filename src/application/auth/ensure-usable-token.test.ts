import { describe, expect, it } from "vitest";
import type { UserTokens } from "../ports/user-token-store";
import { ensureUsableToken } from "./ensure-usable-token";

/**
 * **失効から出られる経路まで見る**（#184。**止める仕組みを入れたら、止まった状態から
 * 出られるかを見る**）。**3 つで 1 組**である。
 *
 * - **失効していたら、更新して復帰する**
 * - **更新にも失敗したら、再ログインへ戻せる**——**「何も見えない画面」で終わらない**
 * - **上の 2 つを、8 時間待たずに確かめられる**（**いまの時刻を渡す**。#131 / #137）
 */
describe("使えるトークンを用意する", () => {
  const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));

  const fresh: UserTokens = {
    accessToken: "fresh-access",
    refreshToken: "the-refresh",
    expiresAt: at(3600),
  };
  const stale: UserTokens = {
    accessToken: "stale-access",
    refreshToken: "the-refresh",
    expiresAt: at(0),
  };

  /** 保存されているものを覚えるだけの置き場。**外部 I/O はモックしない**（`AGENTS.md` §4）。 */
  function storeOf(initial: UserTokens | undefined) {
    let saved = initial;
    return {
      calls: [] as UserTokens[],
      async load() {
        return saved;
      },
      async save(tokens: UserTokens) {
        saved = tokens;
        this.calls.push(tokens);
      },
    };
  }

  it("使えるトークンがあれば、そのまま返す", () => {
    const store = storeOf(fresh);

    return ensureUsableToken({
      store,
      refresh: async () => {
        throw new Error("更新してはいけない");
      },
      now: at(0),
    }).then((result) => {
      expect(result).toEqual({ kind: "usable", accessToken: "fresh-access" });
      expect(store.calls, "使えるのに保存し直している").toHaveLength(0);
    });
  });

  it("失効していたら、更新して復帰する", async () => {
    const store = storeOf(stale);
    const renewed: UserTokens = {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: at(28800),
    };

    const result = await ensureUsableToken({
      store,
      refresh: async (refreshToken) => {
        expect(refreshToken, "保存してあった refresh token を渡していない").toBe("the-refresh");
        return renewed;
      },
      now: at(1),
    });

    expect(result).toEqual({ kind: "usable", accessToken: "new-access" });
    // **更新したものを保存しない**と、**毎回の要求で更新が走る**——
    // **GitHub 側で refresh token は 1 度しか使えない**ので、次で必ず失敗する
    expect(store.calls, "更新したトークンを保存していない").toEqual([renewed]);
    expect(await store.load()).toEqual(renewed);
  });

  it("更新に失敗したら、再ログインへ戻す", async () => {
    // **「何も見えない画面」で終わらせない**（#184）
    const store = storeOf(stale);

    const result = await ensureUsableToken({
      store,
      refresh: async () => {
        throw new Error("refresh token が使えません");
      },
      now: at(1),
    });

    expect(result).toEqual({ kind: "needs-login" });
  });

  it("そもそも保存されていなければ、再ログインへ戻す", async () => {
    // **更新を試みない**——**渡す refresh token が無い**
    const store = storeOf(undefined);
    let refreshed = false;

    const result = await ensureUsableToken({
      store,
      refresh: async () => {
        refreshed = true;
        throw new Error("呼ばれてはいけない");
      },
      now: at(0),
    });

    expect(result).toEqual({ kind: "needs-login" });
    expect(refreshed, "渡すものが無いのに更新を試みている").toBe(false);
  });

  it("保存に失敗したら、使えるとは言わない", async () => {
    // **倒す先は 2 つある。** **保存できないまま「使える」を返すと、次の要求でまた
    // 更新が走り、使い切った refresh token で必ず失敗する**——
    // **その場では動いて見え、次で壊れる。**
    const store = {
      async load() {
        return stale;
      },
      async save() {
        throw new Error("書けません");
      },
    };

    const result = await ensureUsableToken({
      store,
      refresh: async () => ({
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: at(28800),
      }),
      now: at(1),
    });

    expect(result).toEqual({ kind: "needs-login" });
  });
});
