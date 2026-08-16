/**
 * `PullRequestMerges` の GitHub 実装（#331）。
 *
 * **押した人のトークンで行う**——**installation トークンで代用しない**
 * （**保護ルールの「マージできる人」を迂回できる**）。
 *
 * **マージできない理由をこちらで数え直さない。** **ここが見るのは
 * 「断られたことを、断られたと分かる形で受け取れるか」**である。
 *
 * **モックを使わない**（§4）——**`fetch` の差し替えは抽象ではなく引数**である（#64）。
 */

import { describe, expect, it } from "vitest";
import { createGitHubPullRequestMerges } from "./github-pull-request-merge";

const TARGET = { repository: { owner: "acme", name: "web" }, number: 42 } as const;
const USER_TOKEN = "user-token";

function fetcher(response: {
  status: number;
  body: unknown;
}): typeof fetch & { calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch & { calls: typeof calls };
  impl.calls = calls;
  return impl;
}

const MERGED_BODY = { merged: true, sha: "abc123" };

describe("GitHub で PR をマージする", () => {
  it("押した人のトークンで行う", async () => {
    const fetchImpl = fetcher({ status: 200, body: MERGED_BODY });

    await createGitHubPullRequestMerges({ fetchImpl }).merge(USER_TOKEN, TARGET);

    const [call] = fetchImpl.calls;
    expect(call?.url).toBe("https://api.github.com/repos/acme/web/pulls/42/merge");
    expect(call?.init?.method).toBe("PUT");
    expect(new Headers(call?.init?.headers).get("authorization")).toBe(`Bearer ${USER_TOKEN}`);
  });

  it("squash でマージする", async () => {
    // **方法を UI に出さない**（#331 の「やらないこと」）——**1 つに決める**
    const fetchImpl = fetcher({ status: 200, body: MERGED_BODY });

    await createGitHubPullRequestMerges({ fetchImpl }).merge(USER_TOKEN, TARGET);

    expect(JSON.parse(String(fetchImpl.calls[0]?.init?.body))).toEqual({ merge_method: "squash" });
  });

  it("マージできたら merged を返す", async () => {
    const merges = createGitHubPullRequestMerges({
      fetchImpl: fetcher({ status: 200, body: MERGED_BODY }),
    });

    expect(await merges.merge(USER_TOKEN, TARGET)).toEqual({ kind: "merged" });
  });

  it("いまマージできないときは、そう伝える", async () => {
    // **GitHub は 405（整っていない）と 409（head が動いた）で断る。**
    // **どちらも「押した人が GitHub で PR を見に行く」で、行き先が同じ**
    for (const status of [405, 409]) {
      const merges = createGitHubPullRequestMerges({
        fetchImpl: fetcher({ status, body: { message: "Pull Request is not mergeable" } }),
      });

      expect(await merges.merge(USER_TOKEN, TARGET), String(status)).toEqual({
        kind: "not-mergeable",
      });
    }
  });

  it("断られた以外は投げる", async () => {
    // **通信や権限の失敗を「まだマージできません」に化けさせない**
    // ——**押した人は待てば直ると思う**
    for (const status of [401, 403, 404, 422, 500]) {
      const merges = createGitHubPullRequestMerges({
        fetchImpl: fetcher({ status, body: { message: "no" } }),
      });

      await expect(merges.merge(USER_TOKEN, TARGET), String(status)).rejects.toThrow();
    }
  });

  it("マージされていない 200 を、成功と言わない", async () => {
    // **GitHub は `merged: false` を 200 で返すことがある**——**それを
    // 「マージしました」と出すと、入っていない PR が入った顔で並ぶ**
    const merges = createGitHubPullRequestMerges({
      fetchImpl: fetcher({ status: 200, body: { merged: false, sha: "abc123" } }),
    });

    expect(await merges.merge(USER_TOKEN, TARGET)).toEqual({ kind: "not-mergeable" });
  });

  it("応答の形が違ったら投げる", async () => {
    const merges = createGitHubPullRequestMerges({
      fetchImpl: fetcher({ status: 200, body: { merged: "yes" } }),
    });

    await expect(merges.merge(USER_TOKEN, TARGET)).rejects.toThrow();
  });

  it("投げるものに、応答の中身を載せない", async () => {
    // **§6「出力に何が含まれうるかで判断する」**
    const secret = "private-repository-name";
    const merges = createGitHubPullRequestMerges({
      fetchImpl: fetcher({ status: 403, body: { message: secret } }),
    });

    const error = await merges.merge(USER_TOKEN, TARGET).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error, "投げていない").toBeInstanceOf(Error);
    expect(String(error), "応答の中身が載っている").not.toContain(secret);
    expect(String(error)).toContain("403");
  });
});
