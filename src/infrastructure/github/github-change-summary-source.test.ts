import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AppCredentials } from "./app-credentials";
import { createGitHubChangeSummarySource } from "./github-change-summary-source";

// **署名できる鍵を作る。** 偽の文字列だと token の取得で落ち、
// **この試験が見たい分岐まで到達しない**（`github-pull-request-source` と同じ形）
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const CREDENTIALS: AppCredentials = { appId: "1234", privateKey };
const REPOSITORY = { owner: "o", name: "r" };
/** **40 桁の 16 進**。SHA の形をしていないものは URL に入れない（§6） */
const HEAD = "a".repeat(40);

/** どの URL に何を返すか。**本物の GitHub を呼ばない。** */
type Routes = Record<string, { status?: number; body: unknown | (() => unknown); link?: string }>;

/** token の取得はここでは主題ではないので、素通しにする。 */
function tokenResponse(url: string): Response | undefined {
  if (!url.includes("/installation") && !url.includes("/access_tokens")) {
    return undefined;
  }
  return new Response(JSON.stringify({ id: 1, token: "t", expires_at: "2999-01-01T00:00:00Z" }), {
    status: url.includes("/access_tokens") ? 201 : 200,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(routes: Routes): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const token = tokenResponse(url);
    if (token !== undefined) {
      return token;
    }
    const route = Object.entries(routes).find(([key]) => url.includes(key))?.[1];
    if (route === undefined) {
      return new Response("not stubbed", { status: 404 });
    }
    const body = typeof route.body === "function" ? route.body() : route.body;
    return new Response(JSON.stringify(body), {
      status: route.status ?? 200,
      headers: route.link === undefined ? {} : { link: route.link },
    });
  }) as unknown as typeof fetch;
}

function source(routes: Routes) {
  return createGitHubChangeSummarySource({
    credentials: CREDENTIALS,
    repository: REPOSITORY,
    fetchImpl: fakeFetch(routes),
    now: () => new Date("2026-01-01T00:00:00Z"),
  });
}

const OK_ROUTES: Routes = {
  "/pulls/1/files": { body: [{ filename: "src/ui/button.tsx" }] },
  "/pulls/1": { body: { changed_files: 1, additions: 2, deletions: 0, head: { sha: HEAD } } },
  [`/commits/${HEAD}/check-runs`]: {
    body: { check_runs: [{ status: "completed", conclusion: "success" }] },
  },
  // **Commit Status しか登録しない CI がある。** 両方見て初めてどちらでも動く
  [`/commits/${HEAD}/status`]: { body: { state: "success", statuses: [] } },
};

const NEXT_PAGE = '<https://api.github.com/x?page=99>; rel="next"';

describe("createGitHubChangeSummarySource", () => {
  it("実データの形から材料を組み立てる", async () => {
    const listing = await source(OK_ROUTES).listChangeSummaries([1]);

    expect(listing.summaries.get(1)).toEqual({
      changedFileCount: 1,
      changedLineCount: 2,
      touchesSensitivePath: false,
      ciStatus: "passing",
    });
    expect(listing.unavailable).toEqual([]);
  });

  it("1 本が取れなくても、他の PR の結果は返る", async () => {
    // **例外で全体を落とすと、1 本の失敗で画面が真っ白になる**（#116）
    const listing = await source({
      ...OK_ROUTES,
      "/pulls/2": { status: 500, body: {} },
    }).listChangeSummaries([1, 2]);

    expect(listing.summaries.get(1)).toBeDefined();
    expect(listing.summaries.has(2)).toBe(false);
    expect(listing.unavailable.map((entry) => entry.pullRequestNumber)).toEqual([2]);
  });

  it("取れなかった理由が残る", async () => {
    const listing = await source({ "/pulls/1": { status: 500, body: {} } }).listChangeSummaries([
      1,
    ]);

    expect(listing.unavailable[0]?.reason).not.toBe("");
  });

  it("応答に秘密を載せない", async () => {
    // **本文をそのまま理由に入れない**（このリポジトリが繰り返し守っている扱い）
    const listing = await source({
      "/pulls/1": { status: 403, body: { message: "secret-token-leaked" } },
    }).listChangeSummaries([1]);

    expect(listing.unavailable[0]?.reason).not.toContain("secret-token-leaked");
  });

  it("上限まで読んだら、見切れたことが分かる形にする", async () => {
    // **「触れていない」と「見ていない」を混同しない。**
    // 見切れて当たらなかった PR は材料にせず、行だけ残す
    const listing = await source({
      ...OK_ROUTES,
      "/pulls/1/files": {
        body: [{ filename: "src/ui/button.tsx" }],
        link: '<https://api.github.com/repos/o/r/pulls/1/files?page=99>; rel="next"',
      },
    }).listChangeSummaries([1]);

    expect(listing.summaries.has(1)).toBe(false);
    expect(listing.unavailable[0]?.reason).toMatch(/見切れ|多すぎ/);
  });

  it("check run が見切れたら材料にしない", async () => {
    // **ファイル側と同じ向きに倒す。** 「30 件しか見ていないのに passing」は、
    // **「見ていない」を「通っている」と読む**形である
    const listing = await source({
      ...OK_ROUTES,
      [`/commits/${HEAD}/check-runs`]: {
        body: { check_runs: [{ status: "completed", conclusion: "success" }] },
        link: NEXT_PAGE,
      },
    }).listChangeSummaries([1]);

    expect(listing.summaries.has(1)).toBe(false);
    expect(listing.unavailable[0]?.reason).toMatch(/見切れ|多すぎ/);
  });

  it("Commit Status が見切れたら材料にしない", async () => {
    const listing = await source({
      ...OK_ROUTES,
      [`/commits/${HEAD}/status`]: { body: { state: "success", statuses: [] }, link: NEXT_PAGE },
    }).listChangeSummaries([1]);

    expect(listing.summaries.has(1)).toBe(false);
  });

  it("Commit Status を取りに行く", async () => {
    // **Checks API だけを見ると、Commit Status しか使わないリポジトリで
    // すべての PR が永久に pending になる**（安全だが役に立たない）
    const listing = await source({
      ...OK_ROUTES,
      [`/commits/${HEAD}/check-runs`]: { body: { check_runs: [] } },
      [`/commits/${HEAD}/status`]: { body: { state: "success", statuses: [{ state: "success" }] } },
    }).listChangeSummaries([1]);

    expect(listing.summaries.get(1)?.ciStatus).toBe("passing");
  });

  it("取得の途中で head が変われば材料にしない", async () => {
    // **3 回の取得が別々の瞬間を見ている。** 間に push が入ると、
    // **古い版の件数と CI に、新しい版のパス**が混ざる。
    // 古い版が小さくて CI 済みなら、**未検証の新しい版に「読まずにマージしてよい」と出る**。
    // **取り直さない**——また間に push が入りうるので終わらない
    let call = 0;
    const listing = await source({
      ...OK_ROUTES,
      "/pulls/1": {
        body: () => {
          call++;
          return {
            changed_files: 1,
            additions: 2,
            deletions: 0,
            head: { sha: call === 1 ? HEAD : "b".repeat(40) },
          };
        },
      },
    }).listChangeSummaries([1]);

    expect(listing.summaries.has(1)).toBe(false);
    expect(listing.unavailable[0]?.reason).toMatch(/更新|変わ/);
  });

  it("head が SHA の形でなければ、その値で要求しない", async () => {
    // **未検証の値を URL のパスへ入れない**（`AGENTS.md` §6）。
    // **installation トークンが付いている**ので、別の endpoint を叩けてしまう
    const asked: string[] = [];
    const listing = await createGitHubChangeSummarySource({
      credentials: CREDENTIALS,
      repository: REPOSITORY,
      now: () => new Date("2026-01-01T00:00:00Z"),
      fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input);
        asked.push(url);
        if (url.includes("/installation") || url.includes("/access_tokens")) {
          return new Response(
            JSON.stringify({ id: 1, token: "t", expires_at: "2999-01-01T00:00:00Z" }),
            { status: url.includes("/access_tokens") ? 201 : 200 },
          );
        }
        // **ファイルの一覧は読める形で返す。** ここで落とすと、
        // **CI を取りに行く前に終わってしまい、URL を組み立てる箇所を通らない**
        if (url.includes("/files")) {
          return new Response("[]", { status: 200 });
        }
        return new Response(
          JSON.stringify({
            changed_files: 1,
            additions: 1,
            deletions: 0,
            head: { sha: "../../../orgs/other/secrets" },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    }).listChangeSummaries([1]);

    expect(listing.summaries.has(1)).toBe(false);
    expect(asked.some((url) => url.includes("orgs/other/secrets"))).toBe(false);
  });

  describe("打ち切りの合図", () => {
    /**
     * **本当に返らない `fetch`。** 応答を作らない。
     *
     * **即座に落ちる偽物では確かめられない**——それは**遅い口ではなく、壊れた口**である。
     * **合図を受け取ってはじめて返る**形にしてあるので、**受け取らない実装は止まらない。**
     */
    function silentFetch(seen: { count: number }): typeof fetch {
      return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const token = tokenResponse(url);
        if (token !== undefined) {
          return token;
        }
        seen.count += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("中断されました")), {
            once: true,
          });
        });
      }) as unknown as typeof fetch;
    }

    it("合図を受けたら、取れたぶんを持って返る", async () => {
      // **最後まで回すと、呼んだ側が縮退したあとも往復が続く**——
      // **止まるのは呼んだ側だけ**になる
      const deadline = new AbortController();
      const seen = { count: 0 };
      const listing = createGitHubChangeSummarySource({
        credentials: CREDENTIALS,
        repository: REPOSITORY,
        fetchImpl: silentFetch(seen),
      }).listChangeSummaries([1, 2, 3], { signal: deadline.signal });

      // **要求が飛んでから打ち切る。** 先に切ると、1 本も呼ばない経路になる
      await vi.waitFor(() => expect(seen.count).toBeGreaterThan(0));
      deadline.abort();
      const result = await listing;

      expect(result.summaries.size).toBe(0);
      expect(result.unavailable.map((entry) => entry.pullRequestNumber)).toEqual([1, 2, 3]);
      expect(result.unavailable.every((entry) => entry.kind === "timedout")).toBe(true);
    });

    it("合図は fetch まで届く", async () => {
      // **口の中で握り潰さない。** 届かないと、**中断したのに往復だけ続く**
      const deadline = new AbortController();
      const signals: (AbortSignal | undefined)[] = [];
      const listing = createGitHubChangeSummarySource({
        credentials: CREDENTIALS,
        repository: REPOSITORY,
        fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
          const token = tokenResponse(String(input));
          if (token !== undefined) {
            return token;
          }
          signals.push(init?.signal ?? undefined);
          // **合図でだけ返る。** 何も起こさない口にすると、
          // **合図が届いていても届いていなくても、この試験は返らない**
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("中断されました")), {
              once: true,
            });
          });
        }) as unknown as typeof fetch,
      }).listChangeSummaries([1], { signal: deadline.signal });

      await vi.waitFor(() => expect(signals).toHaveLength(1));
      deadline.abort();
      await listing;

      expect(signals[0], "合図が fetch に渡っていない").toBe(deadline.signal);
    });

    /** URL ごとの本文。**分岐を偽物の中で積まない**（読む側も検査器も追えなくなる）。 */
    function bodyFor(url: string): unknown {
      if (url.includes("/files")) {
        return [];
      }
      if (url.includes("/check-runs")) {
        return { check_runs: [] };
      }
      if (url.includes("/status")) {
        return { statuses: [] };
      }
      return { changed_files: 1, additions: 1, deletions: 0, head: { sha: HEAD } };
    }

    it("1 本取れた直後に切れたら、次の PR は取りに行かない", async () => {
      // **合図を見る場所が要る。** 中断で投げる `fetch` なら**捕まえた側**でも気づけるが、
      // **1 本ぶんが正常に終わってから切れた場合**、次の周回へ入る手前で見ていないと
      // **打ち切ったのに往復が続く**。
      const deadline = new AbortController();
      const asked: string[] = [];
      const listing = await createGitHubChangeSummarySource({
        credentials: CREDENTIALS,
        repository: REPOSITORY,
        fetchImpl: (async (input: string | URL | Request) => {
          const url = String(input);
          const token = tokenResponse(url);
          if (token !== undefined) {
            return token;
          }
          asked.push(url);
          // **1 本目の取得が終わる直前に切る。** 時間ではなく、**経路の位置**で切る
          if (url.includes("/status")) {
            deadline.abort();
          }
          return new Response(JSON.stringify(bodyFor(url)), { status: 200 });
        }) as unknown as typeof fetch,
      }).listChangeSummaries([1, 2], { signal: deadline.signal });

      expect(
        asked.some((url) => url.includes("/pulls/2")),
        "2 本目を取りに行っている",
      ).toBe(false);
      expect(listing.summaries.has(1)).toBe(true);
      expect(listing.unavailable).toEqual([
        { pullRequestNumber: 2, kind: "timedout", reason: "期限までに材料が返りませんでした" },
      ]);
    });

    it("認証の往復も、合図で止まる", async () => {
      // **`authorization()` は installation の解決と token の発行で 2 回往復する。**
      // ここに合図が届かないと、**呼んだ側は縮退したのに、認証の要求だけが走り続ける**——
      // **この PR が消しに来た「止まるのは呼んだ側だけ」**が、認証経路に残る。
      //
      // **既存の偽物は認証を即座に返していた**ので、**この経路を 1 度も通っていない**
      // （**起こりえない状態を作る偽物**——#154 と同じ形）
      const deadline = new AbortController();
      const signals: (AbortSignal | undefined)[] = [];
      const listing = createGitHubChangeSummarySource({
        credentials: CREDENTIALS,
        repository: REPOSITORY,
        fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
          // **token の口も応答しない。** ここを返してしまうと、
          // **認証を抜けた先**しか試せない
          signals.push(init?.signal ?? undefined);
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("中断されました")), {
              once: true,
            });
          });
        }) as unknown as typeof fetch,
      }).listChangeSummaries([1], { signal: deadline.signal });

      await vi.waitFor(() => expect(signals).toHaveLength(1));
      deadline.abort();
      const result = await listing;

      expect(signals[0], "認証の fetch に合図が渡っていない").toBe(deadline.signal);
      // **止まったことを、打ち切りとして残す。** ここで投げると、
      // **1 本の失敗で全体が消える**（この口が守ってきたもの）
      expect(result.unavailable).toEqual([
        { pullRequestNumber: 1, kind: "timedout", reason: "期限までに材料が返りませんでした" },
      ]);
    });

    it("token の発行も、合図で止まる", async () => {
      // **認証は 2 回往復する。** installation の解決だけに合図を通しても、
      // **token の発行は誰にも止められないまま走り続ける**——
      // **1 本目だけ直して「届いた」ことにしない。**
      //
      // ここでは **installation だけ即座に返し、token の口を応答させない**
      const deadline = new AbortController();
      const signals: (AbortSignal | undefined)[] = [];
      const listing = createGitHubChangeSummarySource({
        credentials: CREDENTIALS,
        repository: REPOSITORY,
        fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          // **token の URL にも "installation" が入る**（`/app/installations/1/access_tokens`）。
          // 素直に部分一致で分けると、**token の要求に installation の応答を返す**
          if (url.includes("/installation") && !url.includes("/access_tokens")) {
            return new Response(JSON.stringify({ id: 1 }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          signals.push(init?.signal ?? undefined);
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("中断されました")), {
              once: true,
            });
          });
        }) as unknown as typeof fetch,
      }).listChangeSummaries([1], { signal: deadline.signal });

      await vi.waitFor(() => expect(signals).toHaveLength(1));
      deadline.abort();
      const result = await listing;

      expect(signals[0], "token の fetch に合図が渡っていない").toBe(deadline.signal);
      expect(result.unavailable.every((entry) => entry.kind === "timedout")).toBe(true);
    });

    it("合図が無ければ、これまでどおり最後まで集める", async () => {
      // **既定を変えない。** 合図を渡さない呼び出しは、いままでと同じ振る舞いをする
      const listing = await source({
        "/pulls/1/files": { body: [] },
        "/check-runs": { body: { check_runs: [] } },
        "/status": { body: { statuses: [] } },
        "/pulls/1": {
          body: { changed_files: 1, additions: 1, deletions: 0, head: { sha: HEAD } },
        },
      }).listChangeSummaries([1]);

      expect(listing.summaries.has(1)).toBe(true);
      expect(listing.unavailable).toEqual([]);
    });
  });

  it("番号を渡さなければ何も取りに行かない", async () => {
    const listing = await source({}).listChangeSummaries([]);

    expect(listing.summaries.size).toBe(0);
    expect(listing.unavailable).toEqual([]);
  });
});
