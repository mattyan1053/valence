/**
 * **倒す先は 2 つある**（#212 の完了条件）。
 *
 *   **見えるべきものが返らない** … 取得に失敗して空を返す / ページを読み残す
 *   **見えてはいけないものが返る** … ユーザートークン以外で解決する
 *
 * **片方だけ見ると、両方の向きで緑になる形が残る。**
 *
 * **引く向きも見る** (#470)。**その人の全リポジトリを引いて絞る**と、
 * **要求の数が「その人が持っている数」で決まる**——**入り口が 1 分かかり、
 * その先を見てもらえない。** **App が入っている数で決まること**を、
 * **数えて見る**（「速くなった」ではなく、何で決まるか）。
 */

import { describe, expect, it } from "vitest";
import { createUserVisibleRepositories } from "./user-visible-repositories";

type Call = { url: string; init: RequestInit };

/** 応答 1 つ。**続きは `Link` が教える**（件数では当てない）。 */
type Reply = { body: unknown; status?: number; next?: string };

/**
 * 差し替える `fetch`。**URL で引き当てる**——**#470 で口が 2 つになった**ので、
 * **並び順で当てると、どちらを何回叩いたのかが読めない。**
 *
 * **呼ばれ方も見る**（何を持って行ったか）。
 */
function fetcher(replies: Record<string, Reply>): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    const at = String(url);
    calls.push({ url: at, init });
    const reply = replies[at];
    if (reply === undefined) {
      // **知らない口を叩いたら、そう分かるようにする**（黙って空を返さない）
      return new Response(JSON.stringify({ message: `stub に無い: ${at}` }), { status: 599 });
    }
    const headers = reply.next === undefined ? undefined : { link: `<${reply.next}>; rel="next"` };
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const INSTALLATIONS = "https://api.github.com/user/installations?per_page=100";
const reposOf = (id: number) =>
  `https://api.github.com/user/installations/${id}/repositories?per_page=100`;

const repo = (owner: string, name: string) => ({ name, owner: { login: owner } });
const installed = (...ids: number[]) => ({ installations: ids.map((id) => ({ id })) });

describe("ユーザートークンで見られるリポジトリを解決する", () => {
  it("そのユーザーが見られるものを返す", async () => {
    const { fetchImpl } = fetcher({
      [INSTALLATIONS]: { body: installed(11) },
      [reposOf(11)]: { body: { repositories: [repo("acme", "web"), repo("acme", "api")] } },
    });

    const listing = await createUserVisibleRepositories({ fetchImpl }).list("user-token");

    expect(listing.repositories).toEqual([
      { owner: "acme", name: "web" },
      { owner: "acme", name: "api" },
    ]);
    expect(listing.invalid).toEqual([]);
  });

  it("要求の数は、App が入っている数で決まる", async () => {
    // **これが #470 の芯**である。**その人が持っているリポジトリの数で決まると、
    // 200 個持っている人は 200 個ぶん待つ**——**入り口がそれだと、先を見てもらえない。**
    //
    // **`/user/repos` を叩かない**（**そこが「全部引く」口**である）
    const { calls, fetchImpl } = fetcher({
      [INSTALLATIONS]: { body: installed(11) },
      [reposOf(11)]: { body: { repositories: [repo("acme", "web")] } },
    });

    await createUserVisibleRepositories({ fetchImpl }).list("user-token");

    expect(calls, "App が 1 つなのに、2 往復で済んでいない").toHaveLength(2);
    expect(calls.map((call) => call.url).join(" "), "その人の全リポジトリを引いている").not.toMatch(
      /\/user\/repos/,
    );
  });

  it("App が入っている数だけ引く", async () => {
    // **installation はアカウントごと**（`AGENTS.md` §1）——**増えるのは、
    // 別のアカウントに入れたとき**である。**その数だけ引く。**
    const { calls, fetchImpl } = fetcher({
      [INSTALLATIONS]: { body: installed(11, 22) },
      [reposOf(11)]: { body: { repositories: [repo("acme", "web")] } },
      [reposOf(22)]: { body: { repositories: [repo("beta", "app")] } },
    });

    const listing = await createUserVisibleRepositories({ fetchImpl }).list("user-token");

    expect(listing.repositories.map((r) => `${r.owner}/${r.name}`)).toEqual([
      "acme/web",
      "beta/app",
    ]);
    expect(calls).toHaveLength(3);
  });

  it("持って行くのはユーザートークンだけ", async () => {
    // **installation トークンで代用しない**（§6）——**代用すると、
    // 誰がログインしていても同じものが見える**
    const { calls, fetchImpl } = fetcher({
      [INSTALLATIONS]: { body: installed(11) },
      [reposOf(11)]: { body: { repositories: [] } },
    });

    await createUserVisibleRepositories({ fetchImpl }).list("user-token");

    for (const call of calls) {
      expect(new Headers(call.init.headers).get("authorization")).toBe("Bearer user-token");
    }
    // **App として署名しに行かない**（installation トークンを取る経路を踏まない）
    // ——**`/user/installations` は「その人が見られる installation」**で、
    // **`/app/installations`（App の全 installation）ではない**
    expect(calls.map((call) => call.url).join(" ")).not.toMatch(/access_tokens|\/app\//);
  });

  it("`Link` の next が無くなるまで読む", async () => {
    // **読み残すと「見えるべきものが返らない」。** **1 ページ目だけ見て終わると、
    // 見えるはずのリポジトリが黙って消える**
    const second = "https://api.github.com/user/installations/11/repositories?page=2";
    const { calls, fetchImpl } = fetcher({
      [INSTALLATIONS]: { body: installed(11) },
      [reposOf(11)]: { body: { repositories: [repo("acme", "one")] }, next: second },
      [second]: { body: { repositories: [repo("acme", "two")] } },
    });

    const listing = await createUserVisibleRepositories({ fetchImpl }).list("user-token");

    expect(listing.repositories.map((r) => r.name)).toEqual(["one", "two"]);
    expect(calls[2]?.url, "Link が指す先を辿っていない").toBe(second);
  });

  it("installation の一覧も、続きを読む", async () => {
    // **こちらも `Link` で続く**——**読み残すと、その installation のぶんが丸ごと消える**
    const second = "https://api.github.com/user/installations?page=2";
    const { fetchImpl } = fetcher({
      [INSTALLATIONS]: { body: installed(11), next: second },
      [second]: { body: installed(22) },
      [reposOf(11)]: { body: { repositories: [repo("acme", "web")] } },
      [reposOf(22)]: { body: { repositories: [repo("beta", "app")] } },
    });

    const listing = await createUserVisibleRepositories({ fetchImpl }).list("user-token");

    expect(listing.repositories.map((r) => r.owner)).toEqual(["acme", "beta"]);
  });

  it("ページ数で打ち切らない", async () => {
    // **固定の上限を置くと、それを超えて見られる人は一覧を一切使えない**
    // ——**「見えるべきものが返らない」側で、しかも全滅**である（#245 のレビュー）
    const replies: Record<string, Reply> = { [INSTALLATIONS]: { body: installed(11) } };
    const page = (index: number) =>
      index === 0 ? reposOf(11) : `https://api.github.com/user/installations/11/r?page=${index}`;
    for (let index = 0; index < 25; index += 1) {
      replies[page(index)] = {
        body: {
          repositories: Array.from({ length: 100 }, (_, i) => repo("acme", `r${index}-${i}`)),
        },
        ...(index < 24 ? { next: page(index + 1) } : {}),
      };
    }

    const listing = await createUserVisibleRepositories({
      fetchImpl: fetcher(replies).fetchImpl,
    }).list("user-token");

    expect(listing.repositories).toHaveLength(2500);
  });

  it("取得に失敗したら投げる（空を返さない）", async () => {
    // **空を返すと「取得できなかった」が「1 件も見えない」に化ける**——
    // **ログインしているのに何も見えない画面が、正常に見える**
    const { fetchImpl } = fetcher({
      [INSTALLATIONS]: { body: { message: "Bad credentials" }, status: 401 },
    });

    await expect(createUserVisibleRepositories({ fetchImpl }).list("user-token")).rejects.toThrow(
      /401/,
    );
  });

  it("片方の installation が落ちたら、投げる", async () => {
    // **半分だけ返すと、「見えるべきものが返らない」が正常な顔で出る**
    // ——**足りないことに気づけるのは、返らなかったときだけ**である
    const { fetchImpl } = fetcher({
      [INSTALLATIONS]: { body: installed(11, 22) },
      [reposOf(11)]: { body: { repositories: [repo("acme", "web")] } },
      [reposOf(22)]: { body: { message: "boom" }, status: 500 },
    });

    await expect(createUserVisibleRepositories({ fetchImpl }).list("user-token")).rejects.toThrow(
      /500/,
    );
  });

  it("読めなかった 1 件は、黙って捨てない", async () => {
    // **捨てると「読めなかった」が「見えなかった」に化ける**
    const { fetchImpl } = fetcher({
      [INSTALLATIONS]: { body: installed(11) },
      [reposOf(11)]: { body: { repositories: [repo("acme", "web"), { name: 42 }] } },
    });

    const listing = await createUserVisibleRepositories({ fetchImpl }).list("user-token");

    expect(listing.repositories).toEqual([{ owner: "acme", name: "web" }]);
    expect(listing.invalid).toHaveLength(1);
    expect(listing.invalid[0]?.index).toBe(1);
  });

  it("エラーの文面に応答の中身を載せない", async () => {
    // **この要求の応答にはユーザーの持ち物が並ぶ**（§6「出力に何が含まれうるかで判断する」）
    const { fetchImpl } = fetcher({
      [INSTALLATIONS]: { body: { message: "Bad credentials" }, status: 403 },
    });

    await expect(createUserVisibleRepositories({ fetchImpl }).list("secret-token")).rejects.toThrow(
      /^(?!.*(Bad credentials|secret-token)).*$/,
    );
  });

  it("遅いときは、待ち切らずに落とす", async () => {
    // **画面ごと止めない** (#120 / #158 と同じ考え方)——**返らない要求を待ち続けると、
    // 入り口が開かないまま**である。**上限を過ぎたら落とし、使う側は
    // 「いま取得できませんでした」へ倒す。**
    const never = (async (_url: string | URL, init: RequestInit = {}) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;

    await expect(
      createUserVisibleRepositories({ fetchImpl: never, timeoutMs: 20 }).list("user-token"),
    ).rejects.toThrow();
  });
});
