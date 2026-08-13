import { describe, expect, it } from "vitest";
import { exchangeCode, refreshUserTokens } from "./user-token";

/**
 * **設定は応答で裏を取る**（#194 のコメント）。
 *
 * **"User-to-server token expiration" にオプトインしている前提**で設計してあるので、
 * **`expires_in` と `refresh_token` が返ることが前提そのもの**である。
 * **返らなければ、保存するものが無いまま静かに進まない**——
 * **判定不能を「大丈夫」へ倒さない。**
 *
 * **設定画面の見え方ではなく、返ってきたものを見る**（`AGENTS.md` §6
 * 「出力に何が含まれうるかで判断する」と同じ形）。
 */
describe("ユーザートークンの取得", () => {
  const credentials = { clientId: "Iv1.dummy", clientSecret: "dummy-secret" } as const;
  const now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));

  /** GitHub の応答を差し替える。**通信そのものは薄く保つ。** */
  function respondWith(body: unknown, status = 200) {
    const seen: { url?: string; body?: string; accept?: string } = {};
    const fetcher = async (url: string, init: RequestInit) => {
      seen.url = url;
      seen.body = String(init.body);
      seen.accept = new Headers(init.headers).get("accept") ?? undefined;
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    };
    return { fetcher, seen };
  }

  const good = {
    access_token: "gho_access",
    refresh_token: "ghr_refresh",
    expires_in: 28800,
    token_type: "bearer",
  };

  it("交換した 1 組を、期限つきで返す", async () => {
    const { fetcher, seen } = respondWith(good);

    const tokens = await exchangeCode({ credentials, code: "the-code", fetcher, now });

    expect(tokens.accessToken).toBe("gho_access");
    expect(tokens.refreshToken).toBe("ghr_refresh");
    // **秒数ではなく時刻にして返す。** **保存したあと、いつ切れるかを呼ぶ側が
    // 計算し直さなくてよい**（計算が 2 箇所に散ると、片方だけ古くなる）
    expect(tokens.expiresAt).toEqual(new Date(Date.UTC(2026, 0, 1, 8, 0, 0)));
    // **JSON で受け取ることを明示する。** 既定では GitHub は
    // `application/x-www-form-urlencoded` を返し、**Zod へ渡す前に読めない**
    expect(seen.accept).toBe("application/json");
  });

  it("refresh_token が返らなければ、失敗する", async () => {
    // **オプトアウトされた App では返らない。** **保存するものが無いまま進むと、
    // 8 時間後に「ログインしているのに何も見えない」**——**その場では気づけない。**
    const { fetcher } = respondWith({ ...good, refresh_token: undefined });

    await expect(exchangeCode({ credentials, code: "the-code", fetcher, now })).rejects.toThrow(
      /読めませんでした/,
    );
  });

  it("expires_in が返らなければ、失敗する", async () => {
    const { fetcher } = respondWith({ ...good, expires_in: undefined });

    await expect(exchangeCode({ credentials, code: "the-code", fetcher, now })).rejects.toThrow(
      /読めませんでした/,
    );
  });

  it("GitHub が error を返したら、失敗する", async () => {
    // **HTTP 200 で `error` を返す**（GitHub の口はそうしうる）——
    // **状態コードだけを見ていると、`access_token` が無いまま進む**
    const { fetcher } = respondWith({ error: "bad_verification_code" }, 200);

    await expect(exchangeCode({ credentials, code: "the-code", fetcher, now })).rejects.toThrow(
      /読めませんでした/,
    );
  });

  it("断られたら、別の文面で失敗する", async () => {
    const { fetcher } = respondWith({ error: "unauthorized" }, 401);

    await expect(exchangeCode({ credentials, code: "the-code", fetcher, now })).rejects.toThrow(
      /取得できませんでした \(HTTP 401\)/,
    );
  });

  it("失敗の文面に、秘密を載せない", async () => {
    // **この要求の応答には token そのものが入る**（`AGENTS.md` §6）。
    // **中身をそのまま文面にすると、秘密がログへ流れる**
    const { fetcher } = respondWith({ access_token: "gho_leaked", error: "x" }, 500);

    await expect(exchangeCode({ credentials, code: "the-code", fetcher, now })).rejects.toThrow(
      /^(?!.*gho_leaked).*$/s,
    );
  });

  it("送る先と中身に、秘密が要る形で入る", async () => {
    const { fetcher, seen } = respondWith(good);

    await exchangeCode({ credentials, code: "the-code", fetcher, now });

    expect(seen.url).toBe("https://github.com/login/oauth/access_token");
    // **本文へ入れる**（URL のクエリにすると、**ログや履歴に残りやすい**）
    expect(seen.body).toContain("client_secret=dummy-secret");
    expect(seen.body).toContain("code=the-code");
  });

  it("更新も、同じ形で 1 組を返す", async () => {
    const { fetcher, seen } = respondWith(good);

    const tokens = await refreshUserTokens({ credentials, refreshToken: "ghr_old", fetcher, now });

    expect(tokens.accessToken).toBe("gho_access");
    expect(tokens.refreshToken).toBe("ghr_refresh");
    expect(seen.body).toContain("grant_type=refresh_token");
    expect(seen.body).toContain("refresh_token=ghr_old");
  });

  it("更新でも、refresh_token が返らなければ失敗する", async () => {
    // **倒す先は 2 つある。** **交換だけ確かめても、更新の側が緩いままなら
    // 2 回目以降で同じことが起きる。**
    const { fetcher } = respondWith({ ...good, refresh_token: undefined });

    await expect(
      refreshUserTokens({ credentials, refreshToken: "ghr_old", fetcher, now }),
    ).rejects.toThrow(/読めませんでした/);
  });
});
