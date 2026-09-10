/**
 * `PullRequestApprovals` の GitHub 実装（#343）。
 *
 * **読むのもユーザートークンである**（`AGENTS.md` §6）——**installation トークンだと、
 * 誰がログインしていても同じ答えになる。**
 *
 * **承認かどうかの規則は GitHub に決めさせる**（§5）。**「最新の意見だけを数える」
 * 「取り下げられた承認は数えない」をこちらへ写すと、向こうが変わったときに
 * 片方だけ古くなる**——**症状は「承認したのに出ない」で、#343 が消しに来たもの**である。
 *
 * **「承認されていない」と「読めなかった」を分ける**——**混ぜると、押した人は
 * もう一度押す。**
 *
 * **モックを使わない**（§4）——**`fetch` の差し替えは抽象ではなく引数**である（#64）。
 */

import { describe, expect, it } from "vitest";
import { createGitHubPullRequestApprovals } from "./github-pull-request-approvals";

const REPOSITORY = { owner: "acme", name: "web" } as const;
const USER_TOKEN = "user-token";

/** 盤面が見せた head。**承認と突き合わせる相手**である（#635）。 */
const HEAD = "a".repeat(40);
/** 承認が付いたあとに push される前の commit。**head ではない。** */
const OLDER = "b".repeat(40);

/**
 * 意見 1 件。**commit を書かなければ、いまの head に付いたもの**とする。
 *
 * **既定を head にするのは、この口が答えるのが「その commit を承認済みか」だから**
 * である——**commit を書いた試験だけが、ずれた承認の話をしている。**
 */
type Review = string | { state: string; commit: string | null };
type Node = {
  number: number;
  states: readonly Review[];
  moreReviews?: string;
  /** **開いているか。** **書かなければ `OPEN`。** */
  state?: string;
};

function review(entry: Review): unknown {
  const { state, commit } = typeof entry === "string" ? { state: entry, commit: HEAD } : entry;
  // **`commit` は null になりうる**——**force push で消えた commit の承認**である
  return { state, commit: commit === null ? null : { oid: commit } };
}

/** 盤面が見せた head。**この番号を、この commit で聞く。** */
function heads(...numbers: readonly number[]): ReadonlyMap<number, string> {
  return new Map(numbers.map((number) => [number, HEAD]));
}

/**
 * 聞かれた番号ぶんの応答（#668）。**別名で引くので、鍵は `p<番号>`** である。
 *
 * **`state` を書かなければ開いている**——**閉じた PR の話をしている試験だけが書く。**
 */
function page(nodes: readonly Node[]): unknown {
  return {
    data: {
      repository: Object.fromEntries(
        nodes.map(({ number, states, moreReviews, state }) => [
          `p${number}`,
          {
            number,
            state: state ?? "OPEN",
            latestOpinionatedReviews: {
              // **内側にも続きがある**（#346 のレビュー）——**意見の数は 100 で切れる**
              pageInfo: {
                hasNextPage: moreReviews !== undefined,
                endCursor: moreReviews ?? null,
              },
              nodes: states.map(review),
            },
          },
        ]),
      ),
    },
  };
}

/** 1 つの PR の、意見だけの応答（**内側の続きを読む要求への答え**）。 */
function reviewPage(states: readonly Review[], endCursor?: string): unknown {
  return {
    data: {
      repository: {
        pullRequest: {
          latestOpinionatedReviews: {
            pageInfo: { hasNextPage: endCursor !== undefined, endCursor: endCursor ?? null },
            nodes: states.map(review),
          },
        },
      },
    },
  };
}

/**
 * **聞かれた別名のぶんだけに絞る**（#673）。
 *
 * **本物は、聞いた別名のぶんしか返さない。** **fixture が本物より気前が良いと、
 * 「聞いていないのに通る」試験が作れる**——**実際に作れていた**（#671 のレビュー
 * 2 周目。**各バッチの末尾しか載せない実装でも緑**だった）。
 *
 * **本物より狭くもしない。** **別名は必ず鍵として返り、見つからなければ `null`**
 * である——**鍵ごと落とすと、今度は「本物では通るのに試験で落ちる」になる。**
 *
 * **番号を名指していない問い合わせには当てない**（**意見の続きは `$number` で
 * 受ける**）——**当てると、そちらの応答まで組み替えてしまう。**
 */
function askedOnly(body: unknown, query: string): unknown {
  // **別名も読む**（#673 のレビュー）——**番号から鍵を作り直すと、
  // 別名を取り違えた実装でも通る**
  // **名前として通らないものも拾う**（#673 のレビュー 3 周目）——**拾わずに
  // 当たらなくすると、「番号を名指していない問い合わせ」の素通しへ落ちる。**
  // **拾ってから弾く**
  const asked = [...query.matchAll(/([^\s{}]+):\s*pullRequest\(number:\s*(\d+)\)/g)].map(
    (found) => ({ alias: String(found[1]), number: Number(found[2]) }),
  );
  const repository = (body as { data?: { repository?: Record<string, unknown> } })?.data
    ?.repository;
  if (asked.length === 0 || repository === undefined) {
    return body;
  }
  if (asked.some((entry) => !/^[A-Za-z_]\w*$/.test(entry.alias))) {
    // **GraphQL の名前は数字で始められない**——**通すと、別名を作り損ねた
    // 実装が緑になる**（**`p` が落ちた問い合わせは、本物なら構文で落ちる**）
    return { errors: [{ message: "Syntax Error: Expected Name" }] };
  }
  // **落ちるのは「同じ別名に違う引数が付いたとき」だけ**（#673 のレビュー 2 周目）
  // ——**同じ別名・同じ番号は仕様上は通る。** **弾くと、この試験群が守っている
  // 「本物より狭くしない」と食い違う**
  const aliases = new Set(asked.map((entry) => entry.alias));
  const pairs = new Set(asked.map((entry) => `${entry.alias}:${entry.number}`));
  if (aliases.size !== pairs.size) {
    // **GitHub は競合する別名をエラーにする**——**通すと、別名を作り間違えた
    // 実装が緑になる**
    return { errors: [{ message: "Fields conflict because they have differing arguments" }] };
  }
  return {
    ...(body as object),
    data: {
      repository: Object.fromEntries(
        // **中身は番号で引く**（fixture が `p<番号>` で書くため）が、
        // **鍵は問い合わせに書かれた別名**である
        asked.map(({ alias, number }) => [alias, repository[`p${number}`] ?? null]),
      ),
    },
  };
}

/** 応答を順に返す `fetch`。**何をどこへ送ったか**を控える。 */
function fetcher(
  responses: readonly { status: number; body: unknown }[],
): typeof fetch & { calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const response = responses[Math.min(calls.length - 1, responses.length - 1)];
    // **本物に寄せる**（#673）——**聞かれた別名のぶんだけ返す**
    const body = askedOnly(response?.body, String(JSON.parse(String(init?.body)).query));
    return new Response(JSON.stringify(body), {
      status: response?.status ?? 500,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch & { calls: typeof calls };
  impl.calls = calls;
  return impl;
}

/**
 * 送った問い合わせに載っている番号を、**呼んだぶんまとめて**並べる（#668 のレビュー 2 周目）。
 *
 * **集合として比べるため**である——**載せ忘れも載せすぎも、同じ 1 行で落ちる。**
 */
function sentNumbers(calls: readonly { init: RequestInit | undefined }[]): readonly number[] {
  return calls
    .flatMap((call) => [
      ...String(JSON.parse(String(call.init?.body)).query).matchAll(
        /pullRequest\(number: (\d+)\)/g,
      ),
    ])
    .map((found) => Number(found[1]))
    .sort((left, right) => left - right);
}

describe("GitHub から承認の状態を読む", () => {
  it("読む人のトークンで読む", async () => {
    // **installation トークンで読むと、誰がログインしていても同じ答えになる**（§6）
    const fetchImpl = fetcher([{ status: 200, body: page([{ number: 7, states: [] }]) }]);

    await createGitHubPullRequestApprovals({ fetchImpl }).listApprovals(
      USER_TOKEN,
      REPOSITORY,
      heads(7),
    );

    const [call] = fetchImpl.calls;
    expect(call?.url).toBe("https://api.github.com/graphql");
    expect(new Headers(call?.init?.headers).get("authorization")).toBe(`Bearer ${USER_TOKEN}`);
    // **どのリポジトリかは要求ごとに決まる**（設定に固定しない。§1）
    expect(JSON.parse(String(call?.init?.body)).variables).toMatchObject({
      owner: "acme",
      name: "web",
    });
  });

  it("承認が付いている PR を、承認済みとして返す", async () => {
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([{ status: 200, body: page([{ number: 7, states: ["APPROVED"] }]) }]),
    });

    const listing = await approvals.listApprovals(USER_TOKEN, REPOSITORY, heads(7));

    expect([...listing.approved]).toEqual([7]);
    expect(listing.unavailable).toEqual([]);
  });

  it("承認のあとに push された PR を、承認済みにしない", async () => {
    // **これが #635 の 1 点である。** **承認は commit に付く**ので、**そのあとに
    // push されたら、誰も読んでいない差分が「承認済み」の顔をする**——
    // **Merge は見せた commit に固定されている**（#331）のに、**その固定の根拠が
    // 固定されていなかった。**
    //
    // **上の試験との差は commit だけ**である——**同じにしたら緑、ずらしたら赤。**
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([
        {
          status: 200,
          body: page([{ number: 7, states: [{ state: "APPROVED", commit: OLDER }] }]),
        },
      ]),
    });

    const listing = await approvals.listApprovals(USER_TOKEN, REPOSITORY, heads(7));

    expect([...listing.approved], "古い commit の承認を、head の承認として返した").toEqual([]);
    // **「古い」と「読めなかった」を分ける**——**読めてはいる**ので、こちらへは入れない
    expect(listing.unavailable).toEqual([]);
  });

  it("commit の分からない承認を、承認済みにしない", async () => {
    // **`commit` は null になりうる**——**承認が付いた commit が force push で
    // 消えている**。**消えているなら head ではない**ので、承認済みとは言わない。
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([
        {
          status: 200,
          body: page([{ number: 7, states: [{ state: "APPROVED", commit: null }] }]),
        },
      ]),
    });

    const listing = await approvals.listApprovals(USER_TOKEN, REPOSITORY, heads(7));

    expect([...listing.approved]).toEqual([]);
  });

  it("承認が付いていない PR を、承認済みにしない", async () => {
    // **全部を承認済みにする実装でも、上の 1 件だけなら緑になる**
    // ——**付いていない側を並べて初めて、区別していることが分かる**
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([
        {
          status: 200,
          body: page([
            { number: 7, states: ["APPROVED"] },
            { number: 8, states: [] },
            { number: 9, states: ["CHANGES_REQUESTED"] },
          ]),
        },
      ]),
    });

    const listing = await approvals.listApprovals(USER_TOKEN, REPOSITORY, heads(7, 8, 9));

    expect([...listing.approved]).toEqual([7]);
    expect(listing.unavailable).toEqual([]);
  });

  it("最新の意見だけを数えるのは GitHub である", async () => {
    // **取り下げられた承認や、あとから変更を求めた人の古い承認は、
    // `latestOpinionatedReviews` に出てこない**（§5。**こちらで数え直さない**）
    // ——**この試験は「その一覧をそのまま読んでいる」ことを固定する。**
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([
        {
          status: 200,
          body: page([{ number: 7, states: ["CHANGES_REQUESTED", "APPROVED"] }]),
        },
      ]),
    });

    const listing = await approvals.listApprovals(USER_TOKEN, REPOSITORY, heads(7));

    // **1 人でも「最新の意見が承認」なら承認済み**である
    expect([...listing.approved]).toEqual([7]);
  });

  it("聞いていない PR は返さない", async () => {
    // **盤面に無い PR の状態を持ち帰らない**——**画面が使わないものを載せると、
    // 「どれの話か」が曖昧になる**
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([
        {
          status: 200,
          body: page([
            { number: 7, states: ["APPROVED"] },
            { number: 99, states: ["APPROVED"] },
          ]),
        },
      ]),
    });

    const listing = await approvals.listApprovals(USER_TOKEN, REPOSITORY, heads(7));

    expect([...listing.approved]).toEqual([7]);
  });

  it("100 本を超えて聞かれても、全部読む", async () => {
    // **まとめる数は一覧のページと同じ 100**（#668）——**打ち切ると、あふれたぶんから
    // 状態が消える。** **症状は「承認したのに出ない」**で、**#343 が消しに来たもの**である
    const asked = Array.from({ length: 101 }, (_, index) => index + 1);
    const fetchImpl = fetcher([
      { status: 200, body: page(asked.slice(0, 100).map((number) => ({ number, states: [] }))) },
      { status: 200, body: page([{ number: 101, states: ["APPROVED"] }]) },
    ]);
    const approvals = createGitHubPullRequestApprovals({ fetchImpl });

    const listing = await approvals.listApprovals(
      USER_TOKEN,
      REPOSITORY,
      new Map(asked.map((number) => [number, HEAD])),
    );

    expect(fetchImpl.calls, "1 回で聞ける数を超えたのに 1 回しか叩いていない").toHaveLength(2);
    // **送った番号を集合として比べる**（#668 のレビュー 2 周目）——**「含む / 含まない」を
    // 並べても、載せ忘れと載せすぎのどちらかしか見えない。**
    //
    // **応答は聞いた番号と無関係に返る**（この試験の作り）ので、**`approved` と
    // `unavailable` だけでは、何を聞いたかを 1 つも測れない**——**各バッチの末尾しか
    // 載せない実装でも、返ってくるものは変わらない**
    expect(sentNumbers(fetchImpl.calls), "聞いた番号が過不足なく載っていない").toEqual(asked);
    expect([...listing.approved]).toEqual([101]);
    expect(listing.unavailable, "読めたのに読めなかったと言っている").toEqual([]);
  });

  it("聞いた番号だけを問い合わせる", async () => {
    // **前は開いている PR の一覧を丸ごと辿っていた**（#668）——**1 本聞かれても
    // 本数ぶんの往復**になっていた。**実測: open 898 本のリポジトリで 9 ページ・34.9 秒**
    const fetchImpl = fetcher([{ status: 200, body: page([{ number: 7, states: [] }]) }]);

    await createGitHubPullRequestApprovals({ fetchImpl }).listApprovals(
      USER_TOKEN,
      REPOSITORY,
      heads(7),
    );

    const sent = String(JSON.parse(String(fetchImpl.calls[0]?.init?.body)).query);
    expect(sent, "聞いた番号を名指していない").toContain("pullRequest(number: 7)");
    expect(sent, "一覧を丸ごと辿っている").not.toContain("pullRequests(");
  });

  it("閉じた PR は、承認済みにしない", async () => {
    // **前は `states: OPEN` の一覧に居ることが「開いている」の根拠だった**（#668）
    // ——**番号で引くと閉じた PR も返る**ので、**ここで見ないと承認済みの顔をする**
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([
        { status: 200, body: page([{ number: 7, states: ["APPROVED"], state: "MERGED" }]) },
      ]),
    });

    const listing = await approvals.listApprovals(USER_TOKEN, REPOSITORY, heads(7));

    expect([...listing.approved], "閉じた PR を承認済みにしている").toEqual([]);
    expect(listing.unavailable.map((entry) => entry.pullRequestNumber)).toEqual([7]);
  });

  it("答えが返らなかった PR は、「承認されていない」ではなく「読めなかった」", async () => {
    // **閉じた PR や、一覧から落ちたもの**は、**状態が分からないだけ**である
    // ——**`approved` から外すだけだと、画面では承認されていないのと同じに見える**
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([{ status: 200, body: page([{ number: 7, states: ["APPROVED"] }]) }]),
    });

    const listing = await approvals.listApprovals(USER_TOKEN, REPOSITORY, heads(7, 8));

    expect([...listing.approved]).toEqual([7]);
    expect(listing.unavailable.map((row) => row.pullRequestNumber)).toEqual([8]);
  });

  it("意見が 100 件を超えても、承認を取りこぼさない", async () => {
    // **内側の接続にも `pageInfo` がある**（#346 のレビュー。**#322 で 1 度直した罠**）
    // ——**辿らないと、唯一の承認が次のページにある PR で「承認されていない」に化ける。**
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([
        {
          status: 200,
          body: page([{ number: 7, states: ["CHANGES_REQUESTED"], moreReviews: "REVIEWS" }]),
        },
        { status: 200, body: reviewPage(["APPROVED"]) },
      ]),
    });

    const listing = await approvals.listApprovals(USER_TOKEN, REPOSITORY, heads(7));

    expect([...listing.approved], "内側の続きを読んでいない").toEqual([7]);
    expect(listing.unavailable).toEqual([]);
  });

  it("続きを読んでも承認が無ければ、承認済みにしない", async () => {
    // **「読んだ」と「あった」を混ぜない**——**辿った先に無ければ、無いのである**
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([
        {
          status: 200,
          body: page([{ number: 7, states: ["CHANGES_REQUESTED"], moreReviews: "REVIEWS" }]),
        },
        { status: 200, body: reviewPage(["CHANGES_REQUESTED"]) },
      ]),
    });

    const listing = await approvals.listApprovals(USER_TOKEN, REPOSITORY, heads(7));

    expect([...listing.approved]).toEqual([]);
    expect(listing.unavailable).toEqual([]);
  });

  it("1 ページ目の承認が古い commit なら、続きを読む", async () => {
    // **打ち切る条件は「承認があった」ではなく「head に付いた承認があった」**である
    // （#635）——**古い承認で止めると、head を承認した人が次のページにいる PR で
    // 「承認されていない」に化ける。** **早く止める側へ倒さない。**
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([
        {
          status: 200,
          body: page([
            { number: 7, states: [{ state: "APPROVED", commit: OLDER }], moreReviews: "REVIEWS" },
          ]),
        },
        { status: 200, body: reviewPage(["APPROVED"]) },
      ]),
    });

    const listing = await approvals.listApprovals(USER_TOKEN, REPOSITORY, heads(7));

    expect([...listing.approved], "古い承認で打ち切っている").toEqual([7]);
  });

  it("head に付いた承認が 1 ページ目にあれば、続きは読まない", async () => {
    // **要らない往復を作らない**——**1 人でも head を承認していれば、そこで決まる**
    const fetchImpl = fetcher([
      {
        status: 200,
        body: page([{ number: 7, states: ["APPROVED"], moreReviews: "REVIEWS" }]),
      },
    ]);

    await createGitHubPullRequestApprovals({ fetchImpl }).listApprovals(
      USER_TOKEN,
      REPOSITORY,
      heads(7),
    );

    expect(fetchImpl.calls).toHaveLength(1);
  });

  it("打ち切りの合図を、要求へ渡す", async () => {
    // **先に返すだけでは、走っている要求は走り続ける**（`ChangeSummaryRequest` と同じ）
    const fetchImpl = fetcher([{ status: 200, body: page([{ number: 7, states: [] }]) }]);
    const controller = new AbortController();

    await createGitHubPullRequestApprovals({ fetchImpl }).listApprovals(
      USER_TOKEN,
      REPOSITORY,
      heads(7),
      { signal: controller.signal },
    );

    expect(fetchImpl.calls[0]?.init?.signal, "合図が口まで届いていない").toBe(controller.signal);
  });

  it("`data` と `errors` が同時に返ったら、読まない", async () => {
    // **GraphQL は部分的な成功を返す**（#346 のレビュー 2 周目）——**`z.object` は
    // 知らない鍵を捨てる**ので、**「`errors` が載っていたら読まない」と書いてあっても
    // 素通りしていた。** **読める形をしているぶん、いちばん静かに壊れる。**
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([
        {
          status: 200,
          body: {
            ...(page([{ number: 7, states: [] }]) as Record<string, unknown>),
            errors: [{ message: "Something went wrong while executing your query" }],
          },
        },
      ]),
    });

    await expect(approvals.listApprovals(USER_TOKEN, REPOSITORY, heads(7))).rejects.toThrow();
  });

  it("続きがあるのに辿れないなら、承認されていないことにしない", async () => {
    // **`hasNextPage: true` なのに `endCursor` が無い**——**辿れないだけ**であって、
    // **「意見はここで終わり」ではない**（#346 のレビュー 2 周目）。
    // **黙って止まると、次のページの承認が未承認として出る。**
    //
    // **応答は番号で引く形で書く**（#668 のレビュー）——**古い形のまま書くと、
    // `askedSchema` が先に弾いて `rejects` が通り**、**カーソルの検査を消しても緑**になる
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([
        {
          status: 200,
          body: {
            data: {
              repository: {
                p7: {
                  number: 7,
                  state: "OPEN",
                  latestOpinionatedReviews: {
                    // **続きがあると言いながら、行き先が無い**
                    pageInfo: { hasNextPage: true, endCursor: null },
                    nodes: [{ state: "CHANGES_REQUESTED", commit: { oid: HEAD } }],
                  },
                },
              },
            },
          },
        },
        // **辿れたら返るはずのものを置く**（#668 のレビューのあと、変異で確かめた）
        // ——**置かないと、続きの要求が別の形で落ちて、同じ `rejects` が通る。**
        // **カーソルの検査を消しても緑**になり、**守れていない**
        { status: 200, body: reviewPage(["APPROVED"]) },
      ]),
    });

    await expect(approvals.listApprovals(USER_TOKEN, REPOSITORY, heads(7))).rejects.toThrow();
  });

  it("読めなければ投げる", async () => {
    // **空の一覧を返すと、「読めなかった」が「1 件も承認されていない」に化ける**
    // ——**理由つきで残すのは呼ぶ側**である（port の約束）
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([{ status: 502, body: { message: "bad gateway" } }]),
    });

    await expect(approvals.listApprovals(USER_TOKEN, REPOSITORY, heads(7))).rejects.toThrow();
  });

  it("GraphQL がエラーを返したときも投げる", async () => {
    // **`data` が空でも 200 が返る**——**状態コードだけを見ると、
    // 「1 件も承認されていない」として通ってしまう**
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([
        { status: 200, body: { errors: [{ message: "Could not resolve to a Repository" }] } },
      ]),
    });

    await expect(approvals.listApprovals(USER_TOKEN, REPOSITORY, heads(7))).rejects.toThrow();
  });

  it("応答の中身を、例外の文言へ載せない", async () => {
    // **応答にはそのユーザーの持ち物が並びうる**（§6）——**載せるのは状態コードだけ**
    const approvals = createGitHubPullRequestApprovals({
      fetchImpl: fetcher([{ status: 403, body: { message: "secret-repository-name" } }]),
    });

    await expect(approvals.listApprovals(USER_TOKEN, REPOSITORY, heads(7))).rejects.toThrow(
      /^(?!.*secret-repository-name).*$/,
    );
  });

  it("聞かれていなければ、叩きに行かない", async () => {
    // **空の一覧で往復を作らない**
    const fetchImpl = fetcher([{ status: 200, body: page([]) }]);

    const listing = await createGitHubPullRequestApprovals({ fetchImpl }).listApprovals(
      USER_TOKEN,
      REPOSITORY,
      heads(),
    );

    expect(fetchImpl.calls).toEqual([]);
    expect([...listing.approved]).toEqual([]);
    expect(listing.unavailable).toEqual([]);
  });
  it("応答は、聞かれた番号のぶんだけになる", async () => {
    // **本物は、聞いた別名のぶんしか返さない**（#673）——**fixture が本物より
    // 気前が良いと、「聞いていないのに通る」試験が作れる。** **実際に作れていた**
    // （#671 のレビュー 2 周目。**各バッチの末尾しか載せない実装でも緑**だった）
    const fetchImpl = fetcher([
      {
        status: 200,
        body: page([
          { number: 7, states: [] },
          { number: 9, states: [] },
        ]),
      },
    ]);

    const response = await fetchImpl("https://api.github.com/graphql", {
      method: "POST",
      body: JSON.stringify({ query: "{ p7: pullRequest(number: 7) { number } }" }),
    });
    const repository = ((await response.json()) as { data: { repository: object } }).data
      .repository;

    expect(Object.keys(repository), "聞いていない番号まで返している").toEqual(["p7"]);
  });

  it("聞かれた番号が応答に無ければ、無いものとして返る", async () => {
    // **本物より狭くしない**（#673）——**別名は必ず鍵として返り、
    // 見つからなければ `null`** である。**鍵ごと落とすと、本物と形が変わる**
    const fetchImpl = fetcher([{ status: 200, body: page([{ number: 7, states: [] }]) }]);

    const response = await fetchImpl("https://api.github.com/graphql", {
      method: "POST",
      body: JSON.stringify({
        query: "{ p7: pullRequest(number: 7) { number } p8: pullRequest(number: 8) { number } }",
      }),
    });
    const repository = (
      (await response.json()) as { data: { repository: Record<string, unknown> } }
    ).data.repository;

    expect(Object.keys(repository)).toEqual(["p7", "p8"]);
    expect(repository.p8, "見つからなかった別名は null で返る").toBeNull();
  });
  it("応答の鍵は、問い合わせに書かれた別名になる", async () => {
    // **番号から鍵を作り直すと、別名を取り違えた実装でも通る**（#673 のレビュー）
    // ——**本物は、書かれた別名で返す**
    const fetchImpl = fetcher([{ status: 200, body: page([{ number: 7, states: [] }]) }]);

    const response = await fetchImpl("https://api.github.com/graphql", {
      method: "POST",
      body: JSON.stringify({ query: "{ x7: pullRequest(number: 7) { number } }" }),
    });
    const repository = ((await response.json()) as { data: { repository: object } }).data
      .repository;

    expect(Object.keys(repository), "別名を読まずに鍵を作り直している").toEqual(["x7"]);
  });

  it("同じ別名を 2 つの番号に付けたら、本物と同じく通らない", async () => {
    // **GitHub は競合する別名をエラーにする**（#673 のレビュー）——**fixture が
    // 通すと、別名を作り間違えた実装が緑になる**
    const fetchImpl = fetcher([{ status: 200, body: page([{ number: 7, states: [] }]) }]);

    const response = await fetchImpl("https://api.github.com/graphql", {
      method: "POST",
      body: JSON.stringify({
        query: "{ p: pullRequest(number: 7) { number } p: pullRequest(number: 8) { number } }",
      }),
    });
    const payload = (await response.json()) as { errors?: unknown };

    expect(payload.errors, "競合する別名を通している").toBeDefined();
  });
  it("同じ別名・同じ番号なら、エラーにならずに返る", async () => {
    // **GraphQL が落とすのは「同じ別名に違う引数が付いたとき」**である
    // （#673 のレビュー 2 周目）——**同じ別名・同じ番号は仕様上は通る。**
    // **弾くと、この PR 自身が書いた「本物より狭くしない」と食い違う**
    const fetchImpl = fetcher([{ status: 200, body: page([{ number: 7, states: [] }]) }]);

    const response = await fetchImpl("https://api.github.com/graphql", {
      method: "POST",
      body: JSON.stringify({
        query: "{ p7: pullRequest(number: 7) { number } p7: pullRequest(number: 7) { state } }",
      }),
    });
    const payload = (await response.json()) as { errors?: unknown; data?: { repository: object } };

    expect(payload.errors, "本物が通すものを弾いている").toBeUndefined();
    expect(Object.keys(payload.data?.repository ?? {})).toEqual(["p7"]);
  });
  it("数字で始まる別名は、本物と同じく通らない", async () => {
    // **GraphQL の名前は数字で始められない**（#673 のレビュー 3 周目）——**`\w+` は
    // 数字にも当たる**ので、**`askedQuery` から `p` が落ちた問い合わせを、
    // fixture が別名として受け取っていた。**
    //
    // **「当たらなくする」だけでは足りない**——**当たらなくなると
    // 「番号を名指していない問い合わせ」の素通しへ落ちる。** **弾く側へ落とす**
    const fetchImpl = fetcher([{ status: 200, body: page([{ number: 7, states: [] }]) }]);

    const response = await fetchImpl("https://api.github.com/graphql", {
      method: "POST",
      body: JSON.stringify({ query: "{ 7: pullRequest(number: 7) { number } }" }),
    });
    const payload = (await response.json()) as { errors?: unknown };

    expect(payload.errors, "本物が構文で落とすものを通している").toBeDefined();
  });
});
