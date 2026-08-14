import { describe, expect, it } from "vitest";
import type { UserTokenStore, UserTokens } from "../ports/user-token-store";
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
      async clear() {},
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

  it("更新に負けても、勝った側が保存したものを使う", async () => {
    // **失効の瞬間に、同じ人の要求が 2 本並ぶのは普通である**（画面 1 枚でも、
    // RSC もルートも別々に取りに行く）——**refresh token は 1 度しか使えない**ので、
    // **負けた側は必ず失敗する。** **その時点で、保存されているのは使える 1 組**である。
    //
    // **「ログインしているのに何も見えない」を直すものが、
    // 「ログインしているのに再ログインへ飛ばす」を作らない。**
    //
    // **錠は採らない。** **本番はインスタンスが複数ある**ので、
    // **プロセス内の錠は別インスタンスの要求に効かない**——
    // **効かない錠は、効いていることを確かめられないぶん無いより悪い。**
    const winner: UserTokens = {
      accessToken: "winner-access",
      refreshToken: "winner-refresh",
      expiresAt: at(28800),
    };
    let loads = 0;
    const store = {
      async load() {
        loads += 1;
        // 1 回目は失効したもの、2 回目は勝った側が保存したもの
        return loads === 1 ? stale : winner;
      },
      async save() {
        throw new Error("保存してはいけない");
      },
      async clear() {},
    };
    let refreshes = 0;

    const result = await ensureUsableToken({
      store,
      refresh: async () => {
        refreshes += 1;
        throw new Error("refresh token は使用済みです");
      },
      now: at(1),
    });

    expect(result).toEqual({ kind: "usable", accessToken: "winner-access" });
    // **繰り返さない。** **`refresh` を呼び直すと、同じ競合をもう一度開く**
    expect(refreshes, "更新を繰り返している").toBe(1);
  });

  it("読み直したものも使えなければ、再ログインへ戻す", async () => {
    // **倒す先は 2 つある。** **読み直したものを `isUsable` に通さず返すと、
    // 失効したままの access token で GitHub を叩く**——**症状は 401 になり、
    // 「権限が無い」と見分けられない。**
    const store = {
      async load() {
        return stale;
      },
      async save() {
        throw new Error("保存してはいけない");
      },
      async clear() {},
    };

    const result = await ensureUsableToken({
      store,
      refresh: async () => {
        throw new Error("refresh token は使用済みです");
      },
      now: at(1),
    });

    expect(result).toEqual({ kind: "needs-login" });
  });

  it("読み直しに失敗したら、いま出せないと言う", async () => {
    // **読めないことを「使える」へ倒さない。** **倒す先は「入り直し」ではない**
    // ——**置き場が読めないのは、入り直しても直らない** (#214)
    let loads = 0;
    const store = {
      async load() {
        loads += 1;
        if (loads === 1) {
          return stale;
        }
        throw new Error("読めません");
      },
      async save() {
        throw new Error("保存してはいけない");
      },
      async clear() {},
    };

    const result = await ensureUsableToken({
      store,
      refresh: async () => {
        throw new Error("refresh token は使用済みです");
      },
      now: at(1),
    });

    expect(result).toEqual({ kind: "unavailable" });
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
      async clear() {},
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

    expect(result).toEqual({ kind: "unavailable" });
  });
});

describe("置き場の障害を、期限切れと分ける", () => {
  // **#214 の 3 つ目。** **`needs-login` が 3 つの別物を運んでいた**——
  // **「入り直せば直る」「入り直さなくても直る」「入り直しても直らない」**が
  // **同じ 1 つの値**だった。**置き場の障害は、入り直しても直らない。**

  it("読めなかったら unavailable（needs-login ではない）", async () => {
    const store: UserTokenStore = {
      load: async () => {
        throw new Error("置き場が落ちている");
      },
      save: async () => undefined,
      clear: async () => undefined,
    };

    const result = await ensureUsableToken({
      store,
      refresh: async () => {
        throw new Error("呼ばれてはいけない");
      },
      now: new Date(),
    });

    expect(result).toEqual({ kind: "unavailable" });
  });

  it("保存できなかったら unavailable", async () => {
    // **保存し損ねたまま「使える」とは言わない**のは変えない——
    // **倒す先を「入り直し」から「いま出せない」へ移すだけ**である
    const saved = {
      accessToken: "old",
      refreshToken: "r",
      expiresAt: new Date("2020-01-01T00:00:00.000Z"),
    };
    const store: UserTokenStore = {
      load: async () => saved,
      save: async () => {
        throw new Error("書けない");
      },
      clear: async () => undefined,
    };

    const result = await ensureUsableToken({
      store,
      refresh: async () => ({
        accessToken: "new",
        refreshToken: "r2",
        expiresAt: new Date("2999-01-01T00:00:00.000Z"),
      }),
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(result).toEqual({ kind: "unavailable" });
  });
});
