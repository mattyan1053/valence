/**
 * **この画面は静的に焼けない**（#213 のレビュー）。
 *
 * **「いまログインしている人に何が見えるか」**を出すので、**ビルドした瞬間の状態を
 * 焼き付けたら、全テナントに同じものが出る**——**`AGENTS.md` §1 の
 * 「実行時に解決する。設定に固定しない」の逆**である。
 *
 * **落ちているのは env の不足ではない。** **環境変数をビルドへ渡すと通るが、
 * 直っていない**——**直すべきは「このページが静的でよい」という前提**のほうである。
 *
 * **`next build` は `./task check` に入っていない**ので、**手元で緑でも
 * ここは見ていない**——**印を外したら赤になる本を、こちらに置く。**
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { VisibleRepositoriesResult } from "../application/repositories/list-visible-repositories";
import type { CrossRepositoryBoardResult } from "../application/review-order/view-cross-repository-board";
import { showsSignOut } from "../ui/auth/sign-out-button";
import { boardPath, dynamic, renderHome } from "./page";

describe("盤面への行き先", () => {
  // **並べるだけでは、依存グラフもリスク Tier も見られない** (#314)
  it("リポジトリごとの画面を指す", () => {
    expect(boardPath({ owner: "acme", name: "web" })).toBe("/repos/acme/web");
  });

  it("名前をそのまま繋がない", () => {
    // **`/` や `..` の入った値で、別の経路を指させない**
    expect(boardPath({ owner: "acme", name: "../../auth/logout" })).toBe(
      "/repos/acme/..%2F..%2Fauth%2Flogout",
    );
  });
});

describe("入口の画面", () => {
  it("要求ごとに描く（静的に生成させない）", () => {
    // **次に誰かが「静的にすれば速い」と外したら、ここで赤くなる。**
    // **`next build` を呼ばずに済ませている**ぶん、**見ているのは印だけ**である
    // ——**印が効いていることは Next.js の側が持っている。**
    expect(dynamic).toBe("force-dynamic");
  });
});

describe("入口の画面からログアウトできる", () => {
  // **入れるが出られない**（#563）——**`/auth/logout` は POST だけを受ける**のに、
  // **その POST を出すものが画面に 1 つも無かった。**
  const markup = (result: VisibleRepositoriesResult) => renderToStaticMarkup(renderHome(result));

  it("期限が切れている画面から、POST で出せる", () => {
    // **GitHub の token が切れても Supabase のセッションは生きている**
    // ——**「入り直してください」と言われた人が、いまのセッションを捨てられる**
    const html = markup({ kind: "needs-login" });

    expect(html).toContain('action="/auth/logout"');
    expect(html).toContain('method="post"');
  });

  it("並んでいる画面からも出せる", () => {
    const html = markup({
      kind: "listed",
      listing: { repositories: [], invalid: [] },
    });

    expect(html).toContain('action="/auth/logout"');
  });

  it("ログインしていない画面には出さない", () => {
    expect(markup({ kind: "signed-out" })).not.toContain("/auth/logout");
  });

  it("判定は書き写さない", () => {
    // **出す・出さないを決めるのは `showsSignOut` ひとつ**である（§5）
    // ——**盤面と 2 箇所に置くと、片方だけが直る**
    expect(showsSignOut("needs-login")).toBe(true);
    expect(showsSignOut("signed-out")).toBe(false);
  });
});

/**
 * **横断の一覧を `/` から見られる**（#682）。
 *
 * **1 つが読めなくても、他を出す。** **ただし「読めなかった」は残す**
 * ——**口が分けて返している**（#681）ので、**画面はそれを捨てないだけ**である。
 */
describe("入口の画面に、横断の一覧が出る", () => {
  const LISTED: VisibleRepositoriesResult = {
    kind: "listed",
    listing: { repositories: [{ owner: "acme", name: "web" }], invalid: [] },
  };

  function markup(cross: CrossRepositoryBoardResult, at?: Date): string {
    return renderToStaticMarkup(renderHome(LISTED, cross, at));
  }

  const pullRequest = {
    repository: { owner: "acme", name: "api" },
    number: 7,
    title: "図を出す",
    updatedAt: "2026-09-11T00:00:00Z",
  };

  it("複数リポジトリの open PR が、1 つの一覧で見える", () => {
    const html = markup({
      kind: "board",
      listing: {
        pullRequests: [
          pullRequest,
          { ...pullRequest, repository: { owner: "acme", name: "web" }, number: 3 },
        ],
        unavailable: [],
        invalid: [],
      },
      unreadableRepositories: 0,
    });

    expect(html).toContain("acme/api");
    expect(html).toContain("acme/web");
    expect(html).toContain("#7");
    expect(html).toContain("#3");
  });

  it("1 つ読めなかったときに、他が出て、読めなかったことも出る", () => {
    const html = markup({
      kind: "board",
      listing: {
        pullRequests: [pullRequest],
        unavailable: [{ repository: { owner: "acme", name: "web" }, kind: "unreadable" }],
        invalid: [],
      },
      unreadableRepositories: 0,
    });

    expect(html, "読めた側まで消えている").toContain("#7");
    expect(html, "読めなかったことが消えている").toContain("1 件は読めませんでした");
  });

  it("読めなかった材料を、既定値で埋めない", () => {
    // **埋めると「分からない」が「依頼なし」に化ける**（#681 は `undefined` で返す）
    // ——**変異で踏んだ**（**部品の試験だけでは、配線の側を見ていなかった**）
    const html = markup({
      kind: "board",
      listing: { pullRequests: [pullRequest], unavailable: [], invalid: [] },
      unreadableRepositories: 0,
    });

    expect(html, "読めなかったアサインを、依頼なしとして出している").not.toContain(
      "誰にも振られていません",
    );
    expect(html).toContain("誰に振られているかを読めませんでした");
  });

  it("形の読めなかった PR の数も、画面まで運ぶ", () => {
    // **adapter が `invalid` に入れたものが、画面の手前で消えていた**（#686 のレビュー）
    // ——**全部が検証で落ちると「open な PR はありません」と出る**
    const html = markup({
      kind: "board",
      listing: {
        pullRequests: [],
        unavailable: [],
        invalid: [{ repository: { owner: "acme", name: "web" }, index: 0, reason: "形が違う" }],
      },
      unreadableRepositories: 0,
    });

    expect(html, "読めなかった PR が黙って消えている").toContain(
      "1 本は、PR の形を読み取れませんでした",
    );
    // **断定していない側の文には当たらないようにする**（`読めたぶんに、…`）
    expect(html).not.toContain(">open な PR はありません。</p>");
  });

  it("現物への行き先を、こちらで組む", () => {
    // **経路は `app` の話**（§3 の表）——**表示の部品は `app` を import できない**
    expect(
      markup({
        kind: "board",
        listing: { pullRequests: [pullRequest], unavailable: [], invalid: [] },
        unreadableRepositories: 0,
      }),
    ).toContain("https://github.com/acme/api/pull/7");
  });

  it("取りに行った時刻を出す", () => {
    // **「新しい」とは言わない**（#664）
    const html = markup(
      {
        kind: "board",
        listing: { pullRequests: [], unavailable: [], invalid: [] },
        unreadableRepositories: 0,
      },
      new Date("2026-09-11T01:02:03.456Z"),
    );

    expect(html).toContain("2026-09-11T01:02:03Z");
  });

  it("引けなかった理由を、記録の側へ残す", () => {
    // **例外は既に catch 済み**なので、**通常のサーバログにも残らない**（#686 のレビュー）
    // ——**`store` / `token` / `pull-requests/timedout` のどこで落ちたかが分からない。**
    // **リポジトリ別の盤面と同じ形**（#506 の 2）
    const recorded: string[] = [];

    renderToStaticMarkup(
      renderHome(LISTED, { kind: "unavailable", reason: "pull-requests/timedout" }, undefined, {
        report: (action, kind) => recorded.push(`${action}=${kind}`),
      }),
    );

    expect(recorded).toEqual(["home=unavailable/pull-requests/timedout"]);
  });

  it("落ちどころを、画面には出さない", () => {
    // **応答の中身が混ざりうる**（§6）——**記録の側にだけ残す**
    const html = markup({ kind: "unavailable", reason: "pull-requests/timedout" });

    expect(html).not.toContain("timedout");
  });

  it("引けたときは、何も残さない", () => {
    // **毎回鳴る記録は、そのうち読まれなくなる**（#248）
    const recorded: string[] = [];

    renderToStaticMarkup(
      renderHome(
        LISTED,
        {
          kind: "board",
          listing: { pullRequests: [], unavailable: [], invalid: [] },
          unreadableRepositories: 0,
        },
        undefined,
        { report: (action, kind) => recorded.push(`${action}=${kind}`) },
      ),
    );

    expect(recorded).toEqual([]);
  });

  it("引けなかったことを、「1 本も無い」にしない", () => {
    // **黙って空を出すと、故障が「open PR が 0 本」に化ける**
    const html = markup({ kind: "unavailable", reason: "pull-requests/Error" });

    expect(html).toContain("いま取得できませんでした");
    expect(html, "落ちどころを画面へ出している").not.toContain("pull-requests/Error");
  });

  it("横断の一覧を渡さなければ、これまでどおりの画面である", () => {
    // **既存の呼び出しを壊さない**（#682 は足すだけ）
    expect(renderToStaticMarkup(renderHome(LISTED))).not.toContain("横断の一覧");
  });
});

/**
 * **入口の画面でも、誰の番かで絞れる**（#683）。
 *
 * **1 リポジトリの盤面（#663 / #667）と同じ口**である——**別の並びを作らない。**
 */
describe("入口の画面の絞り", () => {
  const LISTED: VisibleRepositoriesResult = {
    kind: "listed",
    listing: { repositories: [], invalid: [] },
  };

  const pullRequest = (owner: string, number: number, reviewers: readonly string[]) => ({
    repository: { owner, name: "web" },
    number,
    title: "図を出す",
    updatedAt: "2026-09-11T00:00:00Z",
    opinion: { approvesHead: false, changesRequestedOnHead: false, reviewed: true },
    assignment: { assignees: [], reviewers, authoredByBot: false },
  });

  const CROSS: CrossRepositoryBoardResult = {
    kind: "board",
    listing: {
      // **#1 はレビューする人の番**（依頼が残っている）、**#2 は誰の番でもない**
      pullRequests: [pullRequest("acme", 1, ["r"]), pullRequest("beta", 2, [])],
      unavailable: [],
      invalid: [],
    },
    unreadableRepositories: 0,
  };

  /** **一覧の中だけ**——**絞りの口は外に出る** */
  function list(markup: string): string {
    const from = markup.indexOf("<ul");
    return from < 0 ? "" : markup.slice(from, markup.indexOf("</ul>", from));
  }

  it("`?ball=` が横断の一覧に効く", () => {
    const html = renderToStaticMarkup(
      renderHome(LISTED, CROSS, undefined, undefined, { ball: "reviewer" }),
    );

    expect(list(html)).toContain("acme/web");
    expect(list(html), "絞りに当たらない行が残っている").not.toContain("beta/web");
  });

  it("画面に無い絞りは、効かせない", () => {
    // **`?ball=` は誰でも好きな文字列を入れられる**（#330 と同じ判断）
    // ——**並べたものだけを通す**
    const html = renderToStaticMarkup(
      renderHome(LISTED, CROSS, undefined, undefined, { ball: "いたずら" }),
    );

    expect(list(html)).toContain("acme/web");
    expect(list(html)).toContain("beta/web");
  });

  it("引き直しても、絞りは残る", () => {
    // **#672 が決めた線**（**絞りは残す／操作の結果は残さない**）——**引き直したら
    // 全部出てきた、では絞った意味が消える**
    const html = renderToStaticMarkup(
      renderHome(LISTED, CROSS, new Date("2026-09-11T00:00:00Z"), undefined, { ball: "reviewer" }),
    );

    expect(html, "引き直す先が絞りを落としている").toContain('href="/?ball=reviewer"');
  });

  it("絞っていなければ、入口へ戻る", () => {
    const html = renderToStaticMarkup(renderHome(LISTED, CROSS, new Date("2026-09-11T00:00:00Z")));

    expect(html).toContain('href="/"');
  });
});
