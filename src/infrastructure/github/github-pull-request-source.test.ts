import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { planReviewOrder } from "../../application/review-order/plan-review-order";
import { mergeReadinessOf } from "../../domain/graph/merge-readiness";
import type { AppCredentials } from "./app-credentials";
import { createGitHubPullRequestSource } from "./github-pull-request-source";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const credentials: AppCredentials = { appId: "1234", privateKey };
const repository = { owner: "mattyan1053", name: "valence" };

/** **installation は実行時に解決する**（AGENTS.md §1）。設定には置かない。 */
const INSTALLATION_URL = "https://api.github.com/repos/mattyan1053/valence/installation";
const OTHER_INSTALLATION_URL = "https://api.github.com/repos/another-org/valence/installation";
const TOKEN_URL = "https://api.github.com/app/installations/5678/access_tokens";
const OTHER_TOKEN_URL = "https://api.github.com/app/installations/9012/access_tokens";
const OTHER_PULLS_URL =
  "https://api.github.com/repos/another-org/valence/pulls?state=open&per_page=100";

const PULLS_URL = "https://api.github.com/repos/mattyan1053/valence/pulls?state=open&per_page=100";
const SECOND_PAGE_URL = "https://api.github.com/repositories/1327515899/pulls?page=2";

/** **REST の一覧に `mergeable` が無い**ので、合流の状況だけ GraphQL で訊く（#629）。 */
const GRAPHQL_URL = "https://api.github.com/graphql";

/** GitHub の応答から、使う項目だけを抜いた形（#60 のテストと同じ作り）。 */
function pull(number: number, baseRef: string, headRef: string) {
  return {
    number,
    base: { ref: baseRef, repo: { id: 1327515899 } },
    head: { ref: headRef, repo: { id: 1327515899 } },
  };
}

type Route = { body: string; status?: number; link?: string };

/**
 * **`fetch` を引数で差し替える**（#64 で決めた形）。interface も HTTP クライアントの
 * 層も作らない。呼ばれた URL を記録して、要求そのものも検査する。
 */
function fakeGitHub(routes: Record<string, Route | Route[]>) {
  const calls: Request[] = [];
  const remaining = new Map<string, Route[]>(
    Object.entries(routes).map(([url, route]) => [
      url,
      Array.isArray(route) ? [...route] : [route],
    ]),
  );

  const fetchImpl: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    const queue = remaining.get(request.url);
    const route = queue?.length === 1 ? queue[0] : queue?.shift();
    if (route === undefined) {
      return Promise.resolve(new Response("見に行かないはずの URL", { status: 599 }));
    }
    return Promise.resolve(
      new Response(route.body, {
        status: route.status ?? 200,
        headers: route.link === undefined ? undefined : { link: route.link },
      }),
    );
  };
  return { calls, fetchImpl };
}

const INSTALLATION: Route = { body: '{"id":5678}' };

function token(expiresAt: string, value = "ghs_ok"): Route {
  return { body: `{"token":"${value}","expires_at":"${expiresAt}"}`, status: 201 };
}

function clockFrom(...times: string[]): () => Date {
  const queue = [...times];
  return () => new Date(queue.length > 1 ? (queue.shift() as string) : (queue[0] as string));
}

describe("GitHub から PR 一覧を取ってくる", () => {
  const stacked = JSON.stringify([pull(8, "main", "feat/a"), pull(9, "feat/a", "feat/b")]);

  it("open な PR の一覧を、そのリポジトリから取る", async () => {
    // **どのリポジトリかは引数で受ける。** installation は複数のリポジトリを持ちうるので、
    // 環境変数に埋めるとリポジトリごとにデプロイが要る
    const { calls, fetchImpl } = fakeGitHub({
      [INSTALLATION_URL]: INSTALLATION,
      [TOKEN_URL]: token("2026-08-10T01:00:00Z"),
      [PULLS_URL]: { body: stacked },
    });

    const listing = await createGitHubPullRequestSource({
      credentials,
      repository,
      fetchImpl,
      now: clockFrom("2026-08-10T00:00:00Z"),
    }).listPullRequests();

    expect(listing.pullRequests.map((pullRequest) => pullRequest.number)).toEqual([8, 9]);
    expect(calls.map((call) => call.url)).toContain(PULLS_URL);
  });

  it("取ってきた token を載せる", async () => {
    const { calls, fetchImpl } = fakeGitHub({
      [INSTALLATION_URL]: INSTALLATION,
      [TOKEN_URL]: token("2026-08-10T01:00:00Z"),
      [PULLS_URL]: { body: stacked },
    });

    await createGitHubPullRequestSource({
      credentials,
      repository,
      fetchImpl,
      now: clockFrom("2026-08-10T00:00:00Z"),
    }).listPullRequests();
    const listCall = calls.find((call) => call.url === PULLS_URL);

    expect(listCall?.headers.get("authorization")).toBe("Bearer ghs_ok");
  });

  it("最後のページまで読む", async () => {
    // **1 ページしか読まないと 31 件目から先が消える。** 消えた PR を base にしている
    // PR は辺を失い、**独立した PR として描かれる**。エラーも警告も出ない
    const { fetchImpl } = fakeGitHub({
      [INSTALLATION_URL]: INSTALLATION,
      [TOKEN_URL]: token("2026-08-10T01:00:00Z"),
      [PULLS_URL]: {
        body: JSON.stringify([pull(8, "main", "feat/a")]),
        link: `<${SECOND_PAGE_URL}>; rel="next", <${SECOND_PAGE_URL}>; rel="last"`,
      },
      [SECOND_PAGE_URL]: { body: JSON.stringify([pull(9, "feat/a", "feat/b")]) },
    });

    const listing = await createGitHubPullRequestSource({
      credentials,
      repository,
      fetchImpl,
      now: clockFrom("2026-08-10T00:00:00Z"),
    }).listPullRequests();

    expect(listing.pullRequests.map((pullRequest) => pullRequest.number)).toEqual([8, 9]);
  });

  it("読み切れなかったら、途中までを成功にしない", async () => {
    // **部分的な一覧はいちばん危ない。** 依存が抜けた図が正しい顔で出る
    const { fetchImpl } = fakeGitHub({
      [INSTALLATION_URL]: INSTALLATION,
      [TOKEN_URL]: token("2026-08-10T01:00:00Z"),
      [PULLS_URL]: {
        body: JSON.stringify([pull(8, "main", "feat/a")]),
        link: `<${SECOND_PAGE_URL}>; rel="next"`,
      },
      [SECOND_PAGE_URL]: { body: '{"message":"Server Error"}', status: 500 },
    });

    await expect(
      createGitHubPullRequestSource({
        credentials,
        repository,
        fetchImpl,
        now: clockFrom("2026-08-10T00:00:00Z"),
      }).listPullRequests(),
    ).rejects.toThrow(/500/);
  });

  it("api.github.com 以外へは続きを取りに行かない", async () => {
    // **token を載せた要求である。** 応答に書かれた URL をそのまま辿ると、
    // 別のホストへ資格情報を送りうる
    const { calls, fetchImpl } = fakeGitHub({
      [INSTALLATION_URL]: INSTALLATION,
      [TOKEN_URL]: token("2026-08-10T01:00:00Z"),
      [PULLS_URL]: {
        body: JSON.stringify([pull(8, "main", "feat/a")]),
        link: '<https://example.com/pulls?page=2>; rel="next"',
      },
    });

    await expect(
      createGitHubPullRequestSource({
        credentials,
        repository,
        fetchImpl,
        now: clockFrom("2026-08-10T00:00:00Z"),
      }).listPullRequests(),
    ).rejects.toThrow();

    // **投げるだけでは足りない。** 送ってしまってから失敗しても、token は既に外へ出ている
    expect(calls.map((call) => call.url)).not.toContain("https://example.com/pulls?page=2");
  });

  it("2 回呼んでも token は 1 回しか取りに行かない", async () => {
    const { calls, fetchImpl } = fakeGitHub({
      [INSTALLATION_URL]: INSTALLATION,
      [TOKEN_URL]: token("2026-08-10T01:00:00Z"),
      [PULLS_URL]: { body: stacked },
    });

    const source = createGitHubPullRequestSource({
      credentials,
      repository,
      fetchImpl,
      now: clockFrom("2026-08-10T00:00:00Z"),
    });
    await source.listPullRequests();
    await source.listPullRequests();

    expect(calls.filter((call) => call.url === TOKEN_URL)).toHaveLength(1);
  });

  it("期限が切れていたら取り直す", async () => {
    const { calls, fetchImpl } = fakeGitHub({
      // **取り直すときは installation の解決からやり直す**（token は installation ごと）
      [INSTALLATION_URL]: INSTALLATION,
      [TOKEN_URL]: [token("2026-08-10T01:00:00Z"), token("2026-08-10T03:00:00Z", "ghs_new")],
      [PULLS_URL]: { body: stacked },
    });

    // **時計は呼ばれた回数で進めない。** installation の解決が入ると now() の
    // 呼び出し回数が変わり、テストのほうが先に壊れる
    let current = "2026-08-10T00:00:00Z";
    const source = createGitHubPullRequestSource({
      credentials,
      repository,
      fetchImpl,
      now: () => new Date(current),
    });
    await source.listPullRequests();
    current = "2026-08-10T02:00:00Z"; // 1 回目の期限より後
    await source.listPullRequests();

    expect(calls.filter((call) => call.url === TOKEN_URL)).toHaveLength(2);
    expect(calls.at(-1)?.headers.get("authorization")).toBe("Bearer ghs_new");
  });

  it("読めなかった PR を捨てない", async () => {
    // #60 で `invalid` を返すようにした意味が、ここで消えないこと
    const { fetchImpl } = fakeGitHub({
      [INSTALLATION_URL]: INSTALLATION,
      [TOKEN_URL]: token("2026-08-10T01:00:00Z"),
      [PULLS_URL]: { body: JSON.stringify([pull(8, "main", "feat/a"), { number: 9 }]) },
    });

    const listing = await createGitHubPullRequestSource({
      credentials,
      repository,
      fetchImpl,
      now: clockFrom("2026-08-10T00:00:00Z"),
    }).listPullRequests();

    expect(listing.pullRequests).toHaveLength(1);
    expect(listing.invalid).toHaveLength(1);
  });

  it("取得に失敗したら投げる。空の一覧にしない", async () => {
    const { fetchImpl } = fakeGitHub({
      [INSTALLATION_URL]: INSTALLATION,
      [TOKEN_URL]: token("2026-08-10T01:00:00Z"),
      [PULLS_URL]: { body: '{"message":"Not Found"}', status: 404 },
    });

    await expect(
      createGitHubPullRequestSource({
        credentials,
        repository,
        fetchImpl,
        now: clockFrom("2026-08-10T00:00:00Z"),
      }).listPullRequests(),
    ).rejects.toThrow(/404/);
  });

  it("投げるときに token を載せない", async () => {
    const { fetchImpl } = fakeGitHub({
      [INSTALLATION_URL]: INSTALLATION,
      [TOKEN_URL]: token("2026-08-10T01:00:00Z", "ghs_leaked"),
      [PULLS_URL]: { body: '{"message":"Not Found"}', status: 404 },
    });

    const message = await createGitHubPullRequestSource({
      credentials,
      repository,
      fetchImpl,
      now: clockFrom("2026-08-10T00:00:00Z"),
    })
      .listPullRequests()
      .catch((error: unknown) => String(error));

    expect(message).not.toContain("ghs_leaked");
  });

  describe("合流の状況", () => {
    /** GraphQL の 1 ページ。**REST の一覧に `mergeable` が無い**ので、こちらで取る。 */
    function statusPage(
      nodes: readonly unknown[],
      pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
        hasNextPage: false,
        endCursor: null,
      },
    ): Route {
      return {
        body: JSON.stringify({ data: { repository: { pullRequests: { pageInfo, nodes } } } }),
      };
    }

    function statusNode(number: number, mergeable: string, mergeStateStatus: string) {
      return { number, mergeable, mergeStateStatus };
    }

    /**
     * 合流の状況だけが返ってこない `fetch`。
     *
     * **`honorsSignal` で行儀を変える**——**本物は合図で reject する**が、
     * **差し替えられる引数なので、無視する実装もありうる。**
     */
    function neverReturning(
      fetchImpl: typeof fetch,
      { honorsSignal }: { honorsSignal: boolean },
    ): typeof fetch {
      return (input, init) => {
        if (new Request(input, init).url !== GRAPHQL_URL) {
          return fetchImpl(input, init);
        }
        return new Promise((_resolve, reject) => {
          if (honorsSignal) {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }
        });
      };
    }

    async function listWithStatuses(...pages: Route[]) {
      const { calls, fetchImpl } = fakeGitHub({
        [INSTALLATION_URL]: INSTALLATION,
        [TOKEN_URL]: token("2026-08-10T01:00:00Z"),
        [PULLS_URL]: { body: stacked },
        [GRAPHQL_URL]: pages,
      });
      const listing = await createGitHubPullRequestSource({
        credentials,
        repository,
        fetchImpl,
        now: clockFrom("2026-08-10T00:00:00Z"),
      }).listPullRequests();
      return { calls, listing };
    }

    it("PR 一覧と一緒に、合流の状況も取ってくる", async () => {
      // **押す前に理由を言うための材料**である（#629）
      const { listing } = await listWithStatuses(
        statusPage([statusNode(9, "CONFLICTING", "DIRTY"), statusNode(8, "MERGEABLE", "BEHIND")]),
      );

      expect(listing.mergeStatuses.get(9)).toEqual({ mergeable: "conflicting", state: "dirty" });
      expect(listing.mergeStatuses.get(8)).toEqual({ mergeable: "mergeable", state: "behind" });
    });

    it("最後のページまで読む", async () => {
      // **打ち切ると、残りの PR が黙って「分からない」へ落ちる**
      const { listing } = await listWithStatuses(
        statusPage([statusNode(8, "MERGEABLE", "CLEAN")], {
          hasNextPage: true,
          endCursor: "Y3Vyc29y",
        }),
        statusPage([statusNode(9, "CONFLICTING", "DIRTY")]),
      );

      expect(listing.mergeStatuses.get(9)).toEqual({ mergeable: "conflicting", state: "dirty" });
    });

    it("そのリポジトリの状況だけを訊く", async () => {
      // **どのリポジトリかは要求ごとに決まる**（`AGENTS.md` §1）
      const { calls } = await listWithStatuses(statusPage([]));
      const asked = calls.filter((call) => call.url === GRAPHQL_URL);

      expect(asked).toHaveLength(1);
      await expect((asked[0] as Request).json()).resolves.toMatchObject({
        variables: { owner: "mattyan1053", name: "valence" },
      });
    });

    it("状況を読めなくても、PR 一覧は返す", async () => {
      // **依存グラフだけでも交通整理の役に立つ**（`collectChanges` と同じ判断）
      // ——**合流の状況のために、盤面ごと落とさない**
      const { listing } = await listWithStatuses({ body: "{}", status: 500 });

      expect(listing.pullRequests.map((pullRequest) => pullRequest.number)).toEqual([8, 9]);
      expect(listing.mergeStatuses.size).toBe(0);
    });

    it("断られた応答は、読めても材料にしない", async () => {
      // **状態コードを見ずに本文だけを読むと、エラーの本文がそれらしいときに
      // 材料として通る**——**「断られた」と「読めなかった」を分ける**（#64 と同じ形）
      const { listing } = await listWithStatuses({
        ...statusPage([statusNode(8, "MERGEABLE", "CLEAN")]),
        status: 500,
      });

      expect(listing.mergeStatuses.size).toBe(0);
    });

    it("応答を読めなくても、PR 一覧は返す", async () => {
      // **200 のまま読めない応答が返る**（GraphQL は失敗も 200 で返す）
      // ——**投げると、盤面ごと落ちる**
      const { listing } = await listWithStatuses({ body: '{"errors":[{"message":"問題"}]}' });

      expect(listing.pullRequests.map((pullRequest) => pullRequest.number)).toEqual([8, 9]);
      expect(listing.mergeStatuses.size).toBe(0);
    });

    it("途中まで読めたぶんは捨てない", async () => {
      // **2 ページ目で落ちても、1 ページ目の PR は理由を言える**
      const { listing } = await listWithStatuses(
        statusPage([statusNode(8, "CONFLICTING", "DIRTY")], {
          hasNextPage: true,
          endCursor: "Y3Vyc29y",
        }),
        { body: "{}", status: 500 },
      );

      expect(listing.mergeStatuses.get(8)).toEqual({ mergeable: "conflicting", state: "dirty" });
      expect(listing.mergeStatuses.has(9)).toBe(false);
    });

    it("返ってこない状況を待ち続けない", async () => {
      // **落ちるのと遅いのは別の経路である**（#119 / #120 と同じ形。#644 のレビュー）
      // ——**`catch` は reject しか拾わない**ので、**応答待ちのまま返らないと
      // `Promise.all` が返らず、盤面ごと出なくなる。**
      const { fetchImpl } = fakeGitHub({
        [INSTALLATION_URL]: INSTALLATION,
        [TOKEN_URL]: token("2026-08-10T01:00:00Z"),
        [PULLS_URL]: { body: stacked },
      });
      const hangingFetch = neverReturning(fetchImpl, { honorsSignal: true });

      const listing = await createGitHubPullRequestSource({
        credentials,
        repository,
        fetchImpl: hangingFetch,
        now: clockFrom("2026-08-10T00:00:00Z"),
        // **期限そのものは短くして試す**——**待つ長さは、この試験の関心ではない**
        mergeStatusDeadline: () => AbortSignal.timeout(5),
      }).listPullRequests();

      expect(listing.pullRequests.map((pullRequest) => pullRequest.number)).toEqual([8, 9]);
      expect(listing.mergeStatuses.size).toBe(0);
    });

    it("合図を無視する fetch でも、待ち続けない", async () => {
      // **口の行儀に頼らない**（#346 のレビュー。#644 のレビュー）——**合図を渡しても、
      // 受け取らない実装・無視する実装はありうる**（`fetchImpl` は差し替えられる）。
      // **待つのをやめる側と、取り消しを伝える側の両方**が要る
      const { fetchImpl } = fakeGitHub({
        [INSTALLATION_URL]: INSTALLATION,
        [TOKEN_URL]: token("2026-08-10T01:00:00Z"),
        [PULLS_URL]: { body: stacked },
      });

      const listing = await createGitHubPullRequestSource({
        credentials,
        repository,
        fetchImpl: neverReturning(fetchImpl, { honorsSignal: false }),
        now: clockFrom("2026-08-10T00:00:00Z"),
        mergeStatusDeadline: () => AbortSignal.timeout(5),
      }).listPullRequests();

      expect(listing.pullRequests.map((pullRequest) => pullRequest.number)).toEqual([8, 9]);
      expect(listing.mergeStatuses.size).toBe(0);
    });

    it("打ち切ったことを、要求の側にも伝える", async () => {
      // **待つのをやめるだけでは、走っている要求は走り続ける**（#346 のレビュー）
      // ——**合図を口まで通す。** **上の試験は「待たない」側しか見ていない**
      const { fetchImpl } = fakeGitHub({
        [INSTALLATION_URL]: INSTALLATION,
        [TOKEN_URL]: token("2026-08-10T01:00:00Z"),
        [PULLS_URL]: { body: stacked },
      });
      let seen: AbortSignal | null | undefined;
      const capturing: typeof fetch = (input, init) => {
        if (new Request(input, init).url === GRAPHQL_URL) {
          seen = init?.signal;
        }
        return neverReturning(fetchImpl, { honorsSignal: false })(input, init);
      };

      await createGitHubPullRequestSource({
        credentials,
        repository,
        fetchImpl: capturing,
        now: clockFrom("2026-08-10T00:00:00Z"),
        mergeStatusDeadline: () => AbortSignal.timeout(5),
      }).listPullRequests();

      expect(seen?.aborted, "合図が要求まで届いていない").toBe(true);
    });

    it("状況を読めなかった PR を、conflict していない側へ倒さない", async () => {
      // **地図に無い番号は `mergeReadinessOf` が `unknown` にする**
      // ——**「読めなかった」が「マージできる」に化けない**
      const { listing } = await listWithStatuses({ body: "{}", status: 500 });

      expect(mergeReadinessOf(listing.mergeStatuses.get(9))).toEqual({ kind: "unknown" });
    });
  });

  it("planReviewOrder にそのまま渡せる", async () => {
    // **繋がっていることを 1 度は通す。** 型が合うことと、実際に順序が出ることは別
    const { fetchImpl } = fakeGitHub({
      [INSTALLATION_URL]: INSTALLATION,
      [TOKEN_URL]: token("2026-08-10T01:00:00Z"),
      [PULLS_URL]: { body: stacked },
    });

    const plan = await planReviewOrder({
      pullRequests: createGitHubPullRequestSource({
        credentials,
        repository,
        fetchImpl,
        now: clockFrom("2026-08-10T00:00:00Z"),
      }),
      // **ここで見たいのは一覧の口が繋がること**なので、材料は空の実装で足りる
      changes: {
        listChangeSummaries: () => Promise.resolve({ summaries: new Map(), unavailable: [] }),
      },
    });

    expect(plan.edges).toEqual([{ dependent: 9, dependsOn: 8 }]);
    expect(plan.order.ordered).toEqual([8, 9]);
  });

  it("installation を実行時に解決してから token を取る", async () => {
    // **設定に置かない**（§1）。owner が違えば installation も違うので、
    // 固定すると **1 テナントしか扱えない**
    const { calls, fetchImpl } = fakeGitHub({
      [INSTALLATION_URL]: INSTALLATION,
      [TOKEN_URL]: token("2026-08-10T01:00:00Z"),
      [PULLS_URL]: { body: stacked },
    });

    await createGitHubPullRequestSource({
      credentials,
      repository,
      fetchImpl,
      now: clockFrom("2026-08-10T00:00:00Z"),
    }).listPullRequests();
    const urls = calls.map((call) => call.url);

    expect(urls.indexOf(INSTALLATION_URL)).toBeGreaterThanOrEqual(0);
    expect(urls.indexOf(INSTALLATION_URL)).toBeLessThan(urls.indexOf(TOKEN_URL));
  });

  it("アカウントが違えば、別の installation の token で取りに行く", async () => {
    // **マルチテナントである**（§1）。同じ App でも、インストール先ごとに token が違う
    const { calls, fetchImpl } = fakeGitHub({
      [INSTALLATION_URL]: INSTALLATION,
      [TOKEN_URL]: token("2026-08-10T01:00:00Z"),
      [PULLS_URL]: { body: stacked },
      [OTHER_INSTALLATION_URL]: { body: '{"id":9012}' },
      [OTHER_TOKEN_URL]: token("2026-08-10T01:00:00Z", "ghs_other"),
      [OTHER_PULLS_URL]: { body: stacked },
    });
    const source = (owner: string) =>
      createGitHubPullRequestSource({
        credentials,
        repository: { owner, name: "valence" },
        fetchImpl,
        now: clockFrom("2026-08-10T00:00:00Z"),
      });

    await source("mattyan1053").listPullRequests();
    await source("another-org").listPullRequests();

    expect(calls.find((call) => call.url === PULLS_URL)?.headers.get("authorization")).toBe(
      "Bearer ghs_ok",
    );
    expect(calls.find((call) => call.url === OTHER_PULLS_URL)?.headers.get("authorization")).toBe(
      "Bearer ghs_other",
    );
  });

  it("installation を解決できなければ投げる", async () => {
    // **空の一覧に丸めない。** App が入っていないことが「PR が 0 件」に化ける
    const { fetchImpl } = fakeGitHub({ [PULLS_URL]: { body: stacked } });

    await expect(
      createGitHubPullRequestSource({
        credentials,
        repository,
        fetchImpl,
        now: clockFrom("2026-08-10T00:00:00Z"),
      }).listPullRequests(),
    ).rejects.toThrow();
  });

  describe("Link ヘッダの読み取り", () => {
    /** 2 ページ目を `link` の書き方だけ変えて辿らせる。 */
    function withLink(link: string) {
      return fakeGitHub({
        [INSTALLATION_URL]: INSTALLATION,
        [TOKEN_URL]: token("2026-08-10T01:00:00Z"),
        [PULLS_URL]: { body: JSON.stringify([pull(8, "main", "feat/a")]), link },
        [SECOND_PAGE_URL]: { body: JSON.stringify([pull(9, "feat/a", "feat/b")]) },
      });
    }

    function listWith(link: string) {
      return createGitHubPullRequestSource({
        credentials,
        repository,
        fetchImpl: withLink(link).fetchImpl,
        now: clockFrom("2026-08-10T00:00:00Z"),
      }).listPullRequests();
    }

    it.each([
      { form: "rel が最初で引用符あり", link: `<${SECOND_PAGE_URL}>; rel="next"` },
      { form: "rel が後ろ", link: `<${SECOND_PAGE_URL}>; type="application/json"; rel="next"` },
      { form: "引用符なし", link: `<${SECOND_PAGE_URL}>; rel=next` },
      {
        form: "他の関係と並ぶ",
        link: `<${PULLS_URL}>; rel="prev", <${SECOND_PAGE_URL}>; rel="next"`,
      },
    ])("$form でも続きを辿る", async ({ link }) => {
      // **`Link` はパラメータの順序も引用形式も保証しない。** 読み落とすと
      // 1 ページで打ち切り、**エラーも警告も出ないまま PR が消える**
      const listing = await listWith(link);

      expect(listing.pullRequests.map((pullRequest) => pullRequest.number)).toEqual([8, 9]);
    });

    it("next が無ければ、そこで終わる", async () => {
      // 「次が無い」は正常。**「読めなかった」と混ぜない**
      const listing = await listWith(`<${PULLS_URL}>; rel="last"`);

      expect(listing.pullRequests.map((pullRequest) => pullRequest.number)).toEqual([8]);
    });

    it("next を含むだけの関係は辿らない", async () => {
      // **`rel` は空白区切りの語である。** 部分一致で拾うと、
      // `rel="nextpage"` のような別の関係を続きだと思って辿る
      const listing = await listWith(`<${SECOND_PAGE_URL}>; rel="nextpage"`);

      expect(listing.pullRequests.map((pullRequest) => pullRequest.number)).toEqual([8]);
    });

    it("読めない Link は投げる", async () => {
      // **「読めなかった」を「次が無い」に丸めない。** 丸めると、
      // 全件のつもりで 1 ページだけ返す
      await expect(listWith("next page over there")).rejects.toThrow();
    });
  });
});

describe("base にどれだけ遅れているか（#639）", () => {
  /** **head の SHA を持つ PR**（`heads` に入る。`compare` の相手になる）。 */
  function pullWithSha(number: number, baseRef: string, headRef: string, sha: string) {
    return {
      ...pull(number, baseRef, headRef),
      head: { ref: headRef, repo: { id: 1327515899 }, sha },
    };
  }

  const SHA = "a".repeat(40);
  const listed = JSON.stringify([pullWithSha(8, "main", "feat/a", SHA)]);
  const statuses = JSON.stringify({
    data: {
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ number: 8, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }],
        },
      },
    },
  });
  const behind = (behindBy: number) =>
    JSON.stringify({ data: { repository: { ref: { compare: { behindBy } } } } });

  it("遅れている数を、合流の状況と一緒に運ぶ", async () => {
    // **`BEHIND` が返らない設定でも数は出る**（#644 のレビューの裏取り）
    // ——**`mergeStateStatus` は `BLOCKED` のまま、compare は 35 を返す。**
    const { calls, fetchImpl } = fakeGitHub({
      [INSTALLATION_URL]: INSTALLATION,
      [TOKEN_URL]: token("2026-08-10T01:00:00Z"),
      [PULLS_URL]: { body: listed },
      [GRAPHQL_URL]: [{ body: statuses }, { body: behind(35) }],
    });

    const listing = await createGitHubPullRequestSource({
      credentials,
      repository,
      fetchImpl,
      now: clockFrom("2026-08-10T00:00:00Z"),
    }).listPullRequests();

    expect(listing.mergeStatuses.get(8)?.behindBy).toBe(35);
    // **状況のほうは書き換えない**——**別の口の答えである**
    expect(listing.mergeStatuses.get(8)?.state).toBe("blocked");
    // **base は枝の名前、head は見せた commit**（#331 と同じ向き）
    const asked = JSON.parse(String(await calls.at(-1)?.text())) as {
      variables: Record<string, unknown>;
    };
    expect(asked.variables).toMatchObject({ base: "main", head: SHA });
  });

  it("読めなくても、合流の状況は残す", async () => {
    // **1 つの失敗で全体を消さない**（`collectSummaries` と同じ判断）
    const { fetchImpl } = fakeGitHub({
      [INSTALLATION_URL]: INSTALLATION,
      [TOKEN_URL]: token("2026-08-10T01:00:00Z"),
      [PULLS_URL]: { body: listed },
      [GRAPHQL_URL]: [{ body: statuses }, { body: "{}", status: 502 }],
    });

    const listing = await createGitHubPullRequestSource({
      credentials,
      repository,
      fetchImpl,
      now: clockFrom("2026-08-10T00:00:00Z"),
    }).listPullRequests();

    // **「読めなかった」を「遅れ 0」にしない**（`AGENTS.md` §5）
    expect(listing.mergeStatuses.get(8)?.behindBy).toBeUndefined();
    expect(listing.mergeStatuses.get(8)?.state).toBe("blocked");
  });

  it("切れている合図では、叩きに行かない", async () => {
    // **呼べば往復が始まる**（`collectChanges` と同じ）
    const { calls, fetchImpl } = fakeGitHub({
      [INSTALLATION_URL]: INSTALLATION,
      [TOKEN_URL]: token("2026-08-10T01:00:00Z"),
      [PULLS_URL]: { body: listed },
      [GRAPHQL_URL]: [{ body: statuses }],
    });

    await createGitHubPullRequestSource({
      credentials,
      repository,
      fetchImpl,
      now: clockFrom("2026-08-10T00:00:00Z"),
      baseLagDeadline: () => AbortSignal.abort(),
    }).listPullRequests();

    expect(calls.filter((call) => call.url === GRAPHQL_URL)).toHaveLength(1);
  });

  it("head の commit が分からない PR は、聞きに行かない", async () => {
    // **`heads` に入らない PR**（`head.sha` が読めなかった）——**相手が無い**
    const { calls, fetchImpl } = fakeGitHub({
      [INSTALLATION_URL]: INSTALLATION,
      [TOKEN_URL]: token("2026-08-10T01:00:00Z"),
      [PULLS_URL]: { body: JSON.stringify([pull(8, "main", "feat/a")]) },
      [GRAPHQL_URL]: [{ body: statuses }],
    });

    await createGitHubPullRequestSource({
      credentials,
      repository,
      fetchImpl,
      now: clockFrom("2026-08-10T00:00:00Z"),
    }).listPullRequests();

    expect(calls.filter((call) => call.url === GRAPHQL_URL)).toHaveLength(1);
  });
});

describe("依存を決めるぶんだけ取る（#650 のレビュー）", () => {
  it("合流の状況も base の遅れも取りに行かない", async () => {
    // **押す経路が待つのは、この往復である**——**`listPullRequests()` は
    // GraphQL を PR の本数ぶん叩く。**
    const { calls, fetchImpl } = fakeGitHub({
      [INSTALLATION_URL]: INSTALLATION,
      [TOKEN_URL]: token("2026-08-10T01:00:00Z"),
      [PULLS_URL]: { body: JSON.stringify([pull(8, "main", "feat/a")]) },
    });

    const listing = await createGitHubPullRequestSource({
      credentials,
      repository,
      fetchImpl,
      now: clockFrom("2026-08-10T00:00:00Z"),
    }).listPullRequestRefs();

    expect(listing.pullRequests.map((pullRequest) => pullRequest.number)).toEqual([8]);
    expect(
      calls.filter((call) => call.url === GRAPHQL_URL),
      "GraphQL を叩いている",
    ).toEqual([]);
  });
});

describe("意見を、見せている head に固定する（#652 のレビュー）", () => {
  // **REST の一覧と GraphQL は同時に走る**ので、**その間に push されると
  // 2 つが別の commit を見る**——**番号だけで結合すると、誰も読んでいない
  // commit に「承認済み」が付く**（#331 / #635 / #643 と同じ形）。
  const SHOWN = "c".repeat(40);
  const OLDER = "d".repeat(40);

  function statuses(headRefOid: string): string {
    return JSON.stringify({
      data: {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                number: 8,
                mergeable: "MERGEABLE",
                mergeStateStatus: "CLEAN",
                headRefOid,
                reviews: { totalCount: 1 },
                latestOpinionatedReviews: {
                  pageInfo: { hasNextPage: false },
                  nodes: [{ state: "APPROVED", commit: { oid: headRefOid } }],
                },
              },
            ],
          },
        },
      },
    });
  }

  const listed = JSON.stringify([
    {
      number: 8,
      base: { ref: "main", repo: { id: 1327515899 } },
      head: { ref: "feat/a", repo: { id: 1327515899 }, sha: SHOWN },
    },
  ]);

  async function opinionsFor(headRefOid: string) {
    const { fetchImpl } = fakeGitHub({
      [INSTALLATION_URL]: INSTALLATION,
      [TOKEN_URL]: token("2026-08-10T01:00:00Z"),
      [PULLS_URL]: { body: listed },
      [GRAPHQL_URL]: [{ body: statuses(headRefOid) }, { body: "{}", status: 502 }],
    });

    const listing = await createGitHubPullRequestSource({
      credentials,
      repository,
      fetchImpl,
      now: clockFrom("2026-08-10T00:00:00Z"),
    }).listPullRequests();
    return listing;
  }

  it("同じ commit を見ていれば、意見をそのまま運ぶ", async () => {
    expect((await opinionsFor(SHOWN)).opinions.get(8)?.approvesHead).toBe(true);
  });

  it("違う commit を見ていたら、意見を落とす", async () => {
    // **落ちれば `ballOf` は `unknown`**——**何も言わない側**である
    const listing = await opinionsFor(OLDER);

    expect(listing.opinions.get(8), "誰も読んでいない commit に意見が付いている").toBeUndefined();
    // **合流の状況は残る**——**別の関心である**
    expect(listing.mergeStatuses.get(8)?.state).toBe("clean");
  });
});
