import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AppCredentials } from "./app-credentials";
import { createGitHubIssueSource } from "./github-issue-source";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const CREDENTIALS: AppCredentials = { appId: "1234", privateKey };
const REPOSITORY = { owner: "o", name: "r" };

const ISSUE = {
  number: 1,
  title: "落ちる",
  assignees: [{ login: "someone" }],
  user: { login: "someone", type: "User" },
};

type Page = { body: unknown; status?: number; link?: string };

function source(pages: Page[], asked: string[] = []) {
  let index = 0;
  return createGitHubIssueSource({
    credentials: CREDENTIALS,
    repository: REPOSITORY,
    now: () => new Date("2026-01-01T00:00:00Z"),
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/access_tokens")) {
        return new Response(JSON.stringify({ token: "t", expires_at: "2999-01-01T00:00:00Z" }), {
          status: 201,
        });
      }
      if (url.includes("/installation")) {
        return new Response(JSON.stringify({ id: 1 }), { status: 200 });
      }
      asked.push(url);
      const page = pages[index++] ?? { body: [] };
      return new Response(JSON.stringify(page.body), {
        status: page.status ?? 200,
        headers: page.link === undefined ? {} : { link: page.link },
      });
    }) as unknown as typeof fetch,
  });
}

describe("createGitHubIssueSource", () => {
  it("open な issue を取ってくる", async () => {
    const asked: string[] = [];
    const listing = await source([{ body: [ISSUE] }], asked).listIssues();

    expect(listing.issues).toEqual([{ number: 1, title: "落ちる" }]);
    expect(asked[0], "閉じたものまで並べている").toContain("state=open");
  });

  it("続きのページも読む", async () => {
    // **1 ページだけ読んで全件のつもりにすると、盤面が黙って一部になる**
    const listing = await source([
      { body: [ISSUE], link: '<https://api.github.com/x?page=2>; rel="next"' },
      { body: [{ ...ISSUE, number: 2 }] },
    ]).listIssues();

    expect(listing.issues.map((issue) => issue.number)).toEqual([1, 2]);
  });

  it("取れなければ投げる", async () => {
    // **空の一覧にすると「取得できなかった」が「issue が 0 件」に化ける**
    await expect(source([{ body: {}, status: 500 }]).listIssues()).rejects.toThrow();
  });

  it("一覧の形が違えば投げる", async () => {
    await expect(source([{ body: { message: "?" } }]).listIssues()).rejects.toThrow();
  });

  it("応答の中身を、エラーに載せない", async () => {
    // **秘密が混ざりうる**（`AGENTS.md` §6）
    await expect(
      source([{ body: { message: "secret-token-leaked" }, status: 403 }]).listIssues(),
    ).rejects.toThrow(/^(?!.*secret-token-leaked).*$/s);
  });
});

describe("打ち切りの合図", () => {
  /** **本当に返らない `fetch`。** 即座に落ちる偽物では、遅い口を確かめられない。 */
  function silentFetch(signals: (AbortSignal | undefined)[]): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/access_tokens")) {
        return new Response(JSON.stringify({ token: "t", expires_at: "2999-01-01T00:00:00Z" }), {
          status: 201,
        });
      }
      if (url.includes("/installation")) {
        return new Response(JSON.stringify({ id: 1 }), { status: 200 });
      }
      signals.push(init?.signal ?? undefined);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("中断されました")), {
          once: true,
        });
      });
    }) as unknown as typeof fetch;
  }

  it("合図は fetch まで届く", async () => {
    // **口の中で握り潰さない。** 届かないと、**中断したのに往復だけ続く**
    const deadline = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    const reading = createGitHubIssueSource({
      credentials: CREDENTIALS,
      repository: REPOSITORY,
      now: () => new Date("2026-01-01T00:00:00Z"),
      fetchImpl: silentFetch(signals),
    })
      .listIssues({ signal: deadline.signal })
      .catch(() => undefined);

    await vi.waitFor(() => expect(signals).toHaveLength(1));
    deadline.abort();
    await reading;

    expect(signals[0], "合図が fetch に渡っていない").toBe(deadline.signal);
  });

  it("合図は、認証の往復にも届く", async () => {
    // **ここが素通しだと、呼んだ側が縮退したあとも認証だけが走り続ける**
    const deadline = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    const reading = createGitHubIssueSource({
      credentials: CREDENTIALS,
      repository: REPOSITORY,
      now: () => new Date("2026-01-01T00:00:00Z"),
      // **token の口も応答しない**——**認証を抜けた先しか試せなくなる**
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        signals.push(init?.signal ?? undefined);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("中断されました")), {
            once: true,
          });
        });
      }) as unknown as typeof fetch,
    })
      .listIssues({ signal: deadline.signal })
      .catch(() => undefined);

    await vi.waitFor(() => expect(signals).toHaveLength(1));
    deadline.abort();
    await reading;

    expect(signals[0], "認証の fetch に合図が渡っていない").toBe(deadline.signal);
  });
});
