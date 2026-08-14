/**
 * 置き場の、**失敗したときの振る舞い**。
 *
 * **本物の Supabase では作りにくい形をここで見る**（壊れた行、落ちた応答）。
 * **繋がることは `user-token-store.db.test.ts` が見ている**ので、ここでは繰り返さない。
 */

import { describe, expect, it } from "vitest";
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

function storeWith(respond: (call: Call) => Response) {
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
  });
  return { store, calls };
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
