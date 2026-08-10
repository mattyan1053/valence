import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { planReviewOrder } from "../../application/review-order/plan-review-order";
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

  it("planReviewOrder にそのまま渡せる", async () => {
    // **繋がっていることを 1 度は通す。** 型が合うことと、実際に順序が出ることは別
    const { fetchImpl } = fakeGitHub({
      [INSTALLATION_URL]: INSTALLATION,
      [TOKEN_URL]: token("2026-08-10T01:00:00Z"),
      [PULLS_URL]: { body: stacked },
    });

    const plan = await planReviewOrder(
      createGitHubPullRequestSource({
        credentials,
        repository,
        fetchImpl,
        now: clockFrom("2026-08-10T00:00:00Z"),
      }),
    );

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
