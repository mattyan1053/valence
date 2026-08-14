/**
 * **倒す先は 2 つある**（#212 の完了条件）。
 *
 *   **見えるべきものが返らない** … 取得に失敗して空を返す / ページを読み残す
 *   **見えてはいけないものが返る** … ユーザートークン以外で解決する
 *
 * **片方だけ見ると、両方の向きで緑になる形が残る。**
 */

import { describe, expect, it } from "vitest";
import { createUserVisibleRepositories } from "./user-visible-repositories";

type Call = { url: string; init: RequestInit };

/** 差し替える `fetch`。**呼ばれ方も見る**（何を持って行ったか）。 */
function fetcher(pages: { body: unknown; status?: number; next?: string }[]): {
  calls: Call[];
  fetchImpl: typeof fetch;
} {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const page = pages[index] ?? { body: [] };
    index += 1;
    // **続きは `Link` が教える**（件数では当てない）
    const headers = page.next === undefined ? undefined : { link: `<${page.next}>; rel="next"` };
    return new Response(JSON.stringify(page.body), { status: page.status ?? 200, headers });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const repo = (owner: string, name: string) => ({ name, owner: { login: owner } });

describe("ユーザートークンで見られるリポジトリを解決する", () => {
  it("そのユーザーが見られるものを返す", async () => {
    const { fetchImpl } = fetcher([{ body: [repo("acme", "web"), repo("acme", "api")] }]);

    const listing = await createUserVisibleRepositories({ fetchImpl }).list("user-token");

    expect(listing.repositories).toEqual([
      { owner: "acme", name: "web" },
      { owner: "acme", name: "api" },
    ]);
    expect(listing.invalid).toEqual([]);
  });

  it("持って行くのはユーザートークンだけ", async () => {
    // **installation トークンで代用しない**（§6）——**代用すると、
    // 誰がログインしていても同じものが見える**
    const { calls, fetchImpl } = fetcher([{ body: [] }]);

    await createUserVisibleRepositories({ fetchImpl }).list("user-token");

    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization"), "ユーザートークンを持って行っていない").toBe(
      "Bearer user-token",
    );
    // **App として署名しに行かない**（installation トークンを取る経路を踏まない）
    expect(calls.map((call) => call.url).join(" ")).not.toMatch(/access_tokens|app\/installations/);
  });

  it("`Link` の next が無くなるまで読む", async () => {
    // **読み残すと「見えるべきものが返らない」。** **1 ページ目だけ見て終わると、
    // 見えるはずのリポジトリが黙って消える**
    const { calls, fetchImpl } = fetcher([
      { body: [repo("acme", "one")], next: "https://api.github.com/user/repos?page=2" },
      { body: [repo("acme", "two")], next: "https://api.github.com/user/repos?page=3" },
      { body: [repo("acme", "three")] },
    ]);

    const listing = await createUserVisibleRepositories({ fetchImpl }).list("user-token");

    expect(listing.repositories.map((r) => r.name)).toEqual(["one", "two", "three"]);
    expect(calls).toHaveLength(3);
    expect(calls[1]?.url, "Link が指す先を辿っていない").toBe(
      "https://api.github.com/user/repos?page=2",
    );
  });

  it("ページ数で打ち切らない", async () => {
    // **固定の上限を置くと、それを超えて見られる人は一覧を一切使えない**
    // ——**「見えるべきものが返らない」側で、しかも全滅**である（#245 のレビュー）。
    // **件数で最後のページを当てるのも同じ**（満杯が続くと終わらない）
    const pages = Array.from({ length: 25 }, (_, index) => ({
      body: Array.from({ length: 100 }, (_, i) => repo("acme", `r${index}-${i}`)),
      ...(index < 24 ? { next: `https://api.github.com/user/repos?page=${index + 2}` } : {}),
    }));
    const { fetchImpl } = fetcher(pages);

    const listing = await createUserVisibleRepositories({ fetchImpl }).list("user-token");

    expect(listing.repositories).toHaveLength(2500);
  });

  it("取得に失敗したら投げる（空を返さない）", async () => {
    // **空を返すと「取得できなかった」が「1 件も見えない」に化ける**——
    // **ログインしているのに何も見えない画面が、正常に見える**
    const { fetchImpl } = fetcher([{ body: { message: "Bad credentials" }, status: 401 }]);

    await expect(createUserVisibleRepositories({ fetchImpl }).list("user-token")).rejects.toThrow(
      /401/,
    );
  });

  it("読めなかった 1 件は、黙って捨てない", async () => {
    // **捨てると「読めなかった」が「見えなかった」に化ける**
    const { fetchImpl } = fetcher([{ body: [repo("acme", "web"), { name: 42 }] }]);

    const listing = await createUserVisibleRepositories({ fetchImpl }).list("user-token");

    expect(listing.repositories).toEqual([{ owner: "acme", name: "web" }]);
    expect(listing.invalid).toHaveLength(1);
    expect(listing.invalid[0]?.index).toBe(1);
  });

  it("エラーの文面に応答の中身を載せない", async () => {
    // **この要求の応答にはユーザーの持ち物が並ぶ**（§6「出力に何が含まれうるかで判断する」）
    const { fetchImpl } = fetcher([{ body: { message: "Bad credentials" }, status: 403 }]);

    await expect(createUserVisibleRepositories({ fetchImpl }).list("secret-token")).rejects.toThrow(
      /^(?!.*(Bad credentials|secret-token)).*$/,
    );
  });
});
