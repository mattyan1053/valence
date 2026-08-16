/**
 * `PullRequestReviews` の GitHub 実装（#330）。
 *
 * **押した人のトークンで出す**——**installation トークンで代用しない**
 * （**人の判断で #317 から持ち越された条件**）。
 *
 * **自己承認は GitHub が弾く。** **こちらで「作者かどうか」を数え直さない**ので、
 * **ここが見るのは「弾かれたことを、弾かれたと分かる形で受け取れるか」**である。
 *
 * **モックを使わない**（§4）——**`fetch` の差し替えは抽象ではなく引数**である（#64）。
 */

import { describe, expect, it } from "vitest";
import { createGitHubPullRequestReviews } from "./github-pull-request-review";

const TARGET = { repository: { owner: "acme", name: "web" }, number: 42 } as const;
const USER_TOKEN = "user-token";

/** 応答を決められる `fetch`。**何をどこへ送ったか**を控える。 */
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

const APPROVED_BODY = { id: 1, state: "APPROVED" };

describe("GitHub に承認を出す", () => {
  it("押した人のトークンで出す", async () => {
    // **installation トークンで出すと、GitHub から見た承認者は App になる**
    // ——**本人には出せない承認（自己承認・保護ルールへの計上）が出せてしまう**
    const fetchImpl = fetcher({ status: 200, body: APPROVED_BODY });

    await createGitHubPullRequestReviews({ fetchImpl }).approve(USER_TOKEN, TARGET);

    const [call] = fetchImpl.calls;
    expect(call?.url).toBe("https://api.github.com/repos/acme/web/pulls/42/reviews");
    expect(call?.init?.method).toBe("POST");
    expect(new Headers(call?.init?.headers).get("authorization")).toBe(`Bearer ${USER_TOKEN}`);
    expect(JSON.parse(String(call?.init?.body))).toEqual({ event: "APPROVE" });
  });

  it("承認できたら approved を返す", async () => {
    const reviews = createGitHubPullRequestReviews({
      fetchImpl: fetcher({ status: 200, body: APPROVED_BODY }),
    });

    expect(await reviews.approve(USER_TOKEN, TARGET)).toEqual({ kind: "approved" });
  });

  it("自分の PR を承認しようとして弾かれたら、そう伝える", async () => {
    // **GitHub は 422 と文面で返す。** **押した人には「なぜ押せないか」が
    // 伝わらなければならない**（#330 の完了条件）
    const reviews = createGitHubPullRequestReviews({
      fetchImpl: fetcher({
        status: 422,
        body: { message: "Unprocessable Entity: Can not approve your own pull request" },
      }),
    });

    expect(await reviews.approve(USER_TOKEN, TARGET)).toEqual({ kind: "self-approval" });
  });

  it("知らない 422 を、自己承認に化けさせない", async () => {
    // **文面が変わったら「分からない」へ倒す**——**倒す向きはこちら**である。
    // **「自己承認でした」と嘘を言うと、押した人は自分の PR でないものを
    // 自分のものだと思う**（**承認が出ていないことは、どちらでも変わらない**）
    const reviews = createGitHubPullRequestReviews({
      fetchImpl: fetcher({ status: 422, body: { message: "Review cannot be requested" } }),
    });

    await expect(reviews.approve(USER_TOKEN, TARGET)).rejects.toThrow();
  });

  it("断られたら投げる", async () => {
    for (const status of [401, 403, 404, 500]) {
      const reviews = createGitHubPullRequestReviews({
        fetchImpl: fetcher({ status, body: { message: "no" } }),
      });

      await expect(reviews.approve(USER_TOKEN, TARGET), String(status)).rejects.toThrow();
    }
  });

  it("承認になっていない応答を、成功と言わない", async () => {
    // **`event` を取り違えれば `COMMENTED` が返る**——**それを「承認しました」と
    // 出すと、誰も承認していない PR が承認済みとして並ぶ**
    const reviews = createGitHubPullRequestReviews({
      fetchImpl: fetcher({ status: 200, body: { id: 1, state: "COMMENTED" } }),
    });

    await expect(reviews.approve(USER_TOKEN, TARGET)).rejects.toThrow();
  });

  it("応答の形が違ったら投げる", async () => {
    const reviews = createGitHubPullRequestReviews({
      fetchImpl: fetcher({ status: 200, body: { id: "1" } }),
    });

    await expect(reviews.approve(USER_TOKEN, TARGET)).rejects.toThrow();
  });

  it("投げるものに、応答の中身を載せない", async () => {
    // **§6「出力に何が含まれうるかで判断する」**——**この要求の応答には
    // そのユーザーの持ち物が並ぶ**
    //
    // **`rejects.toThrow(expect.not.stringContaining(...))` では測れない**
    // ——**実際に載せてみても緑のままだった**（変異で確かめた）。
    // **投げたものを受け取って、文面そのものを見る。**
    const secret = "private-repository-name";
    const reviews = createGitHubPullRequestReviews({
      fetchImpl: fetcher({ status: 403, body: { message: secret } }),
    });

    const error = await reviews.approve(USER_TOKEN, TARGET).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error, "投げていない").toBeInstanceOf(Error);
    expect(String(error), "応答の中身が載っている").not.toContain(secret);
    // **状態コードは載せてよい**（載っていないと、何が起きたか誰にも分からない）
    expect(String(error)).toContain("403");
  });
});
