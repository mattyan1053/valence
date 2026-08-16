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

const HEAD_SHA = "5e2a91c4d7f60b83ae15cd429f70b6d8e3a142cb";
const TARGET = {
  repository: { owner: "acme", name: "web" },
  number: 42,
  headSha: HEAD_SHA,
} as const;
const USER_TOKEN = "user-token";

/** 許可されている方式。**既定は squash だけ**（このリポジトリの慣行）。 */
const ALLOWED = {
  allow_squash_merge: true,
  allow_merge_commit: false,
  allow_rebase_merge: false,
};

/**
 * 応答を決められる `fetch`。
 *
 * **2 つの要求に答える**——**リポジトリの設定**（許可されている方式）と、
 * **マージそのもの**。**分けているのは、方式を要求ごとに引くから**である（#331 のレビュー）。
 */
function fetcher(
  merge: { status: number; body: unknown },
  settings: { status: number; body: unknown } = { status: 200, body: ALLOWED },
): typeof fetch & { calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const answer = String(url).endsWith("/merge") ? merge : settings;
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch & { calls: typeof calls };
  impl.calls = calls;
  return impl;
}

/** マージの要求だけを取り出す。**設定を引く要求と混ぜない。** */
function mergeCall(fetchImpl: ReturnType<typeof fetcher>) {
  return fetchImpl.calls.find((call) => call.url.endsWith("/merge"));
}

const MERGED_BODY = { merged: true, sha: "abc123" };

describe("GitHub で PR をマージする", () => {
  it("押した人のトークンで行う", async () => {
    const fetchImpl = fetcher({ status: 200, body: MERGED_BODY });

    await createGitHubPullRequestMerges({ fetchImpl }).merge(USER_TOKEN, TARGET);

    const call = mergeCall(fetchImpl);
    expect(call?.url).toBe("https://api.github.com/repos/acme/web/pulls/42/merge");
    expect(call?.init?.method).toBe("PUT");
    expect(new Headers(call?.init?.headers).get("authorization")).toBe(`Bearer ${USER_TOKEN}`);
  });

  it("盤面で見せた commit に固定して送る", async () => {
    // **これが無いと、盤面を出してから押すまでに push された変更まで
    // マージされる**（#331 のレビュー）——**利用者が確かめていないものが入る。**
    // **載せて初めて、GitHub が head の食い違いを 409 で返す。**
    const fetchImpl = fetcher({ status: 200, body: MERGED_BODY });

    await createGitHubPullRequestMerges({ fetchImpl }).merge(USER_TOKEN, TARGET);

    expect(JSON.parse(String(mergeCall(fetchImpl)?.init?.body)).sha).toBe(HEAD_SHA);
  });

  it("許可されている方式を、要求ごとに引いて選ぶ", async () => {
    // **squash 固定にしない**（#331 のレビュー）——**無効にしている
    // リポジトリでは全要求が 405 になり、しかも「コンフリクト」と案内される**
    for (const [settings, expected] of [
      [ALLOWED, "squash"],
      [{ allow_squash_merge: false, allow_merge_commit: true, allow_rebase_merge: true }, "merge"],
      [
        { allow_squash_merge: false, allow_merge_commit: false, allow_rebase_merge: true },
        "rebase",
      ],
    ] as const) {
      const fetchImpl = fetcher(
        { status: 200, body: MERGED_BODY },
        { status: 200, body: settings },
      );

      await createGitHubPullRequestMerges({ fetchImpl }).merge(USER_TOKEN, TARGET);

      expect(JSON.parse(String(mergeCall(fetchImpl)?.init?.body)).merge_method, expected).toBe(
        expected,
      );
    }
  });

  it("どの方式も許可されていなければ、マージしに行かない", async () => {
    // **押しても 405 になるだけ**——**要求を出さずに「いまはできない」と伝える**
    const fetchImpl = fetcher(
      { status: 200, body: MERGED_BODY },
      {
        status: 200,
        body: { allow_squash_merge: false, allow_merge_commit: false, allow_rebase_merge: false },
      },
    );

    const outcome = await createGitHubPullRequestMerges({ fetchImpl }).merge(USER_TOKEN, TARGET);

    expect(outcome).toEqual({ kind: "not-mergeable" });
    expect(mergeCall(fetchImpl), "マージを要求している").toBeUndefined();
  });

  it("許可されている方式を読めなければ投げる", async () => {
    // **「許可されていない」と「読めなかった」を混ぜない**
    const fetchImpl = fetcher({ status: 200, body: MERGED_BODY }, { status: 500, body: {} });

    await expect(
      createGitHubPullRequestMerges({ fetchImpl }).merge(USER_TOKEN, TARGET),
    ).rejects.toThrow();
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
