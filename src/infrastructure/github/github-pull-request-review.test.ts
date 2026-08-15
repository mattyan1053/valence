/**
 * `PullRequestReview` の GitHub 実装（#315）。
 *
 * **境界で分類する。** **応答の中身をそのまま内側へ入れない**（`AGENTS.md` §6）——
 * **他人の持ち物が混ざりうる**ので、**「どの種類の断りか」へ畳んでから渡す。**
 *
 * **外部入力は Zod で検証する**（§3 / §6）——**成功したかどうかを、
 * 検証した値から決める。**
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AppCredentials } from "./app-credentials";
import { createGitHubPullRequestReview } from "./github-pull-request-review";

const REPOSITORY = { owner: "acme", name: "web" } as const;

/** 鍵は試験用に作る。**本物は読まない**（署名できないと token を取れない）。 */
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const CREDENTIALS: AppCredentials = { appId: "1234", privateKey };

/**
 * 偽の `fetch`。**installation の解決と token の発行までは通す**——
 * **そこを本物にすると、この試験が網を要求する。**
 */
function fetcher(review: { status: number; body?: unknown }) {
  const calls: { url: string; method: string }[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    // **token の発行を先に見る。** **`/app/installations/42/access_tokens` は
    // `/installation` も含む**ので、順序を逆にすると token が取れない（実際に踏んだ）
    if (url.includes("/access_tokens")) {
      return new Response(JSON.stringify({ token: "ghs_x", expires_at: "2999-01-01T00:00:00Z" }), {
        status: 201,
      });
    }
    if (url.endsWith("/installation")) {
      return new Response(JSON.stringify({ id: 42 }), { status: 200 });
    }
    return new Response(review.body === undefined ? "" : JSON.stringify(review.body), {
      status: review.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, impl };
}

function reviewer(review: { status: number; body?: unknown }) {
  const { calls, impl } = fetcher(review);
  return {
    calls,
    port: createGitHubPullRequestReview({
      credentials: CREDENTIALS,
      repository: REPOSITORY,
      fetchImpl: impl,
    }),
  };
}

describe("GitHub へ Approve を出す", () => {
  it("受け付けられたら approved", async () => {
    const { calls, port } = reviewer({ status: 200, body: { id: 1, state: "APPROVED" } });

    expect(await port.approve(7)).toEqual({ kind: "approved" });
    // **App として叩く**（§6 の「操作は installation トークン」）
    const posted = calls.filter((call) => call.method === "POST" && call.url.includes("/reviews"));
    expect(
      posted.map((call) => call.url),
      "PR の reviews へ出していない",
    ).toEqual(["https://api.github.com/repos/acme/web/pulls/7/reviews"]);
  });

  it("状態が APPROVED でなければ、成功にしない", async () => {
    // **検証した値から決める**（§3）。**2xx だから成功、にすると、
    // GitHub が別の状態を返した日に「押したのに付いていない」が起きる**
    const { port } = reviewer({ status: 200, body: { id: 1, state: "COMMENTED" } });

    expect(await port.approve(7)).toEqual({ kind: "refused", reason: "unavailable" });
  });

  it("応答が読めなければ、成功にしない", async () => {
    const { port } = reviewer({ status: 200, body: { unexpected: true } });

    expect(await port.approve(7)).toEqual({ kind: "refused", reason: "unavailable" });
  });

  it.each([
    [403, "not-permitted"],
    [422, "not-reviewable"],
    [404, "gone"],
    [500, "unavailable"],
    [502, "unavailable"],
  ] as const)("%i は %s として返す", async (status, reason) => {
    // **行き先が違うものを 1 つにまとめない**——**押した人にできることが変わる**
    const { port } = reviewer({ status, body: { message: "secret detail" } });

    expect(await port.approve(7)).toEqual({ kind: "refused", reason });
  });

  it("GitHub の文面を、そのまま内側へ入れない", async () => {
    // **応答には他人の持ち物が混ざりうる**（§6）——**分類だけを返す**
    const { port } = reviewer({
      status: 403,
      body: { message: "Resource not accessible by acme" },
    });

    expect(JSON.stringify(await port.approve(7))).not.toContain("acme");
  });

  it("通信が落ちたら、成功にしない", async () => {
    const port = createGitHubPullRequestReview({
      credentials: CREDENTIALS,
      repository: REPOSITORY,
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });

    expect(await port.approve(7)).toEqual({ kind: "refused", reason: "unavailable" });
  });
});
