import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
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

function fakeFetch(routes: Routes): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    // token の取得はここでは主題ではないので、素通しにする
    if (url.includes("/installation") || url.includes("/access_tokens")) {
      return new Response(
        JSON.stringify({ id: 1, token: "t", expires_at: "2999-01-01T00:00:00Z" }),
        {
          status: url.includes("/access_tokens") ? 201 : 200,
          headers: { "content-type": "application/json" },
        },
      );
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

  it("番号を渡さなければ何も取りに行かない", async () => {
    const listing = await source({}).listChangeSummaries([]);

    expect(listing.summaries.size).toBe(0);
    expect(listing.unavailable).toEqual([]);
  });
});
