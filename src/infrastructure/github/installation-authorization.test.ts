import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AppCredentials } from "./app-credentials";
import { createInstallationAuthorization } from "./installation-authorization";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const CREDENTIALS: AppCredentials = { appId: "1234", privateKey };
const REPOSITORY = { owner: "o", name: "r" };

function tokenFetch(expiresAt: string, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    if (url.includes("/access_tokens")) {
      return new Response(JSON.stringify({ token: "t", expires_at: expiresAt }), { status: 201 });
    }
    if (url.includes("/installation")) {
      return new Response(JSON.stringify({ id: 1 }), { status: 200 });
    }
    void init;
    return new Response("not stubbed", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("createInstallationAuthorization", () => {
  it("installation を解決して、header を組み立てる", async () => {
    const authorization = createInstallationAuthorization({
      credentials: CREDENTIALS,
      repository: REPOSITORY,
      fetchImpl: tokenFetch("2999-01-01T00:00:00Z"),
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    expect(await authorization()).toBe("Bearer t");
  });

  it("期限が来るまでは、取り直さない", async () => {
    // **1 要求ごとに取り直すと、盤面を出すだけで往復が本数ぶん増える**
    const seen: string[] = [];
    const authorization = createInstallationAuthorization({
      credentials: CREDENTIALS,
      repository: REPOSITORY,
      fetchImpl: tokenFetch("2999-01-01T00:00:00Z", seen),
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    await authorization();
    await authorization();

    expect(seen.filter((url) => url.includes("/access_tokens"))).toHaveLength(1);
  });

  it("期限が近ければ、取り直す", async () => {
    // **期限ちょうどまで使うと、要求の途中で切れる**——**症状は「権限が無い」に見える**
    const seen: string[] = [];
    const authorization = createInstallationAuthorization({
      credentials: CREDENTIALS,
      repository: REPOSITORY,
      fetchImpl: tokenFetch("2026-01-01T00:00:30Z", seen),
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    await authorization();
    await authorization();

    expect(seen.filter((url) => url.includes("/access_tokens"))).toHaveLength(2);
  });

  it("合図を、認証の往復まで届ける", async () => {
    // **ここが素通しだと、呼んだ側が縮退したあとも認証だけが走り続ける**
    const deadline = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    const authorization = createInstallationAuthorization({
      credentials: CREDENTIALS,
      repository: REPOSITORY,
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        signals.push(init?.signal ?? undefined);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("中断されました")), {
            once: true,
          });
        });
      }) as unknown as typeof fetch,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    const pending = authorization(deadline.signal).catch(() => undefined);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    deadline.abort();
    await pending;

    expect(signals[0], "認証の fetch に合図が渡っていない").toBe(deadline.signal);
  });
});
