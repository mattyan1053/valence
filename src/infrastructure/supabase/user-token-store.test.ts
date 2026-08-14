/**
 * 置き場の、**失敗したときの振る舞い**。
 *
 * **本物の Supabase では作りにくい形をここで見る**（壊れた行、落ちた応答）。
 * **繋がることは `user-token-store.db.test.ts` が見ている**ので、ここでは繰り返さない。
 */

import { describe, expect, it } from "vitest";
import { ensureUsableToken } from "../../application/auth/ensure-usable-token";
import { encryptToken, readEncryptionKey } from "../crypto/token-cipher";
import { createSupabaseUserTokenStore, type Fetcher } from "./user-token-store";

const KEY = readEncryptionKey({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64") });
const OTHER_KEY = readEncryptionKey({
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
});
const USER_ID = "11111111-1111-4111-8111-111111111111";

const TOKENS = {
  accessToken: "gho_access",
  refreshToken: "ghr_refresh",
  expiresAt: new Date("2030-01-01T00:00:00.000Z"),
};

type Call = { url: string; init: RequestInit };

type Extras = {
  readonly timeoutMs?: number;
  readonly remainingMs?: () => number | undefined;
};

function storeWith(respond: (call: Call) => Response | Promise<Response>, extras: Extras = {}) {
  const calls: Call[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  };
  const store = createSupabaseUserTokenStore({
    url: "http://supabase.test/",
    publishableKey: "publishable",
    userId: USER_ID,
    userAccessToken: "user-token",
    key: KEY,
    fetcher,
    now: () => new Date("2026-08-14T00:00:00.000Z"),
    ...extras,
  });
  return { store, calls };
}

/** **返ってこない置き場。** **時間制限が無ければ、呼んだ側は永久に止まる。** */
function neverResponds(): Promise<Response> {
  return new Promise<Response>(() => {});
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sealedRow(overrides: Record<string, unknown> = {}) {
  return {
    access_token: encryptToken(KEY, USER_ID, TOKENS.accessToken),
    refresh_token: encryptToken(KEY, USER_ID, TOKENS.refreshToken),
    expires_at: "2030-01-01T00:00:00+00:00",
    ...overrides,
  };
}

describe("Supabase のユーザートークン置き場", () => {
  it("自分の行だけを取りに行く", async () => {
    const { store, calls } = storeWith(() => jsonResponse([]));
    await store.load();
    expect(calls[0]?.url).toContain(`user_id=eq.${USER_ID}`);
  });

  it("行が無ければ、まだ保存していないものとして返る", async () => {
    const { store } = storeWith(() => jsonResponse([]));
    expect(await store.load()).toBeUndefined();
  });

  it("封じた行は、元の 1 組に戻る", async () => {
    const { store } = storeWith(() => jsonResponse([sealedRow()]));
    expect(await store.load()).toEqual(TOKENS);
  });

  it("取得が失敗したら投げる", async () => {
    const { store } = storeWith(() => jsonResponse({ message: "gho_leaked" }, 500));
    await expect(store.load()).rejects.toThrow(/取得できません \(HTTP 500\)/);
  });

  it("失敗の文面に、応答の中身を載せない", async () => {
    const { store } = storeWith(() => jsonResponse({ message: "gho_leaked" }, 500));
    await expect(store.load()).rejects.not.toThrow(/gho_leaked/);
  });

  it("応答が JSON でなければ投げる", async () => {
    const { store } = storeWith(() => new Response("<html>", { status: 200 }));
    await expect(store.load()).rejects.toThrow(/取得できません/);
  });

  it("列が足りない行は投げる", async () => {
    const { store } = storeWith(() => jsonResponse([{ access_token: "x" }]));
    await expect(store.load()).rejects.toThrow(/取得できません/);
  });

  it("期限が日時として読めない行は投げる", async () => {
    // **文字列のまま通すと、失効の比較が辞書順になって静かに壊れる。**
    const { store } = storeWith(() => jsonResponse([sealedRow({ expires_at: "きのう" })]));
    await expect(store.load()).rejects.toThrow(/取得できません/);
  });

  it("復号できない行は、「まだ保存していない」に倒さない", async () => {
    // **鍵が違う（あるいは書き換えられた）行。** `undefined` を返すと、
    // **呼ぶ側は「初めての人」として上書きし、壊れたことに誰も気づかない。**
    const { store } = storeWith(() =>
      jsonResponse([
        sealedRow({ access_token: encryptToken(OTHER_KEY, USER_ID, TOKENS.accessToken) }),
      ]),
    );
    await expect(store.load()).rejects.toThrow(/復号できません/);
  });

  it("保存する本文に、平文の token を入れない", async () => {
    const { store, calls } = storeWith(() => new Response(null, { status: 201 }));
    await store.save(TOKENS);
    const body = String(calls[0]?.init.body);
    expect(body).not.toContain(TOKENS.accessToken);
    expect(body).not.toContain(TOKENS.refreshToken);
    expect(body).toContain(USER_ID);
  });

  it("保存は上書きとして送る", async () => {
    const { store, calls } = storeWith(() => new Response(null, { status: 201 }));
    await store.save(TOKENS);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.prefer).toBe("resolution=merge-duplicates");
  });

  it("消すときも、自分の行だけを狙う", async () => {
    const { store, calls } = storeWith(() => new Response(null, { status: 204 }));
    await store.clear();
    expect(calls[0]?.init.method).toBe("DELETE");
    expect(calls[0]?.url).toContain(`user_id=eq.${USER_ID}`);
  });

  it("消す行が無くても成功にする", async () => {
    // **ログアウトは何度でも押せる。** 2 度目を失敗にすると、
    // **「消えていない」と読めてしまう。**
    const { store } = storeWith(() => new Response(null, { status: 204 }));
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it("消せなかったら投げる", async () => {
    // **黙って成功にすると、「消えた」と思ったまま残る。**
    const { store } = storeWith(() => jsonResponse({ message: "だめ" }, 403));
    await expect(store.clear()).rejects.toThrow(/削除できません \(HTTP 403\)/);
  });

  it("保存が失敗したら投げる", async () => {
    const { store } = storeWith(() => jsonResponse({ message: "だめ" }, 403));
    await expect(store.save(TOKENS)).rejects.toThrow(/保存できません \(HTTP 403\)/);
  });
});

describe("返ってこない置き場を、決めた時間で諦める", () => {
  // **#254 のレビュー。** **返ってこなければ、画面はそのまま止まる**——
  // **落ちてはいないので、どこにも失敗が出ない**（**待っている画面だけが残る**）。

  it("読みは、決めた時間で諦める", async () => {
    const { store } = storeWith(neverResponds, { timeoutMs: 20 });
    await expect(store.load()).rejects.toThrow(/取得できません \(20 ms/);
  });

  it("書きも、決めた時間で諦める", async () => {
    // **止まるのは読みだけではない。** **保存が返らなければ、同じように止まる**
    const { store } = storeWith(neverResponds, { timeoutMs: 20 });
    await expect(store.save(TOKENS)).rejects.toThrow(/保存できません \(20 ms/);
  });

  it("消すのも、決めた時間で諦める", async () => {
    const { store } = storeWith(neverResponds, { timeoutMs: 20 });
    await expect(store.clear()).rejects.toThrow(/削除できません \(20 ms/);
  });

  it("諦めるとき、繋がっている口も閉じる", async () => {
    // **投げるだけでは、往復はまだ生きている**——**応答を待つ socket が残る。**
    // **`signal` を渡していなければ、閉じる手立てがそもそも無い**
    const { store, calls } = storeWith(neverResponds, { timeoutMs: 20 });

    await expect(store.load()).rejects.toThrow();
    expect(calls[0]?.init.signal, "中断の口を渡していない").toBeDefined();
    expect(calls[0]?.init.signal?.aborted, "諦めたのに、往復は生きたまま").toBe(true);
  });

  it("返る置き場では、時間制限に当たらない", async () => {
    // **制限そのものが、普通の読みを壊していないこと**
    const { store } = storeWith(() => jsonResponse([sealedRow()]), { timeoutMs: 20 });
    expect(await store.load()).toEqual(TOKENS);
  });
});

describe("分け合う予算のほうが短ければ、そちらで諦める", () => {
  // **待つ側は「あとどれだけ待てるか」を持っている** (#255)。
  // **置き場がそれより長く粘ると、待ちの上限が上限でなくなる**——
  // **`wait-for-winners-save.ts` の予算は、往復にも食われる**からである。

  it("残りが短ければ、残りで諦める", async () => {
    const { store } = storeWith(neverResponds, { timeoutMs: 5_000, remainingMs: () => 20 });
    await expect(store.load()).rejects.toThrow(/取得できません \(20 ms/);
  });

  it("残りのほうが長ければ、自分の制限で諦める", async () => {
    // **短いほうを採る。** **予算が長いからといって、置き場が粘ってよいわけではない**
    const { store } = storeWith(neverResponds, { timeoutMs: 20, remainingMs: () => 5_000 });
    await expect(store.load()).rejects.toThrow(/取得できません \(20 ms/);
  });

  it("予算が始まっていなければ、自分の制限で諦める", async () => {
    // **待つ前の 1 回目の読みがここ。** **待ちの予算はまだ動いていない**
    const { store } = storeWith(neverResponds, { timeoutMs: 20, remainingMs: () => undefined });
    await expect(store.load()).rejects.toThrow(/取得できません \(20 ms/);
  });
});

describe("諦めたときの行き先", () => {
  // **本物の置き場を、本物の `ensureUsableToken` に渡して見る**（`AGENTS.md` §4）。
  // **投げたものがどう読まれるかは、置き場の側だけでは決まらない。**

  it("時間制限で諦めても、入り直しへは送らない", async () => {
    // **入り直しても直らない** (#214)。**「入り直してください」と言うと、
    // 直らない道へ送るうえ、本当のログイン切れと混ざる**
    const { store } = storeWith(neverResponds, { timeoutMs: 20 });

    const result = await ensureUsableToken({
      store,
      refresh: async () => {
        throw new Error("呼ばれてはいけない");
      },
      now: new Date(),
      waitForWinnersSave: async () => false,
    });

    expect(result).toEqual({ kind: "unavailable" });
  });
});
