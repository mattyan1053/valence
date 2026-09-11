/**
 * **横断の一覧は、読めなかったことを捨てない**（#682）。
 *
 * **口が `unreadable` / `truncated` を分けて返している**（#681）ので、
 * **画面はそれを出すだけ**である——**捨てると、盤面は静かに不完全になる。**
 *
 * **跨がないものが出ていないこと**も、ここで見る（#662）。
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CrossRepositoryBoardProps, CrossRepositoryRow } from "./cross-repository-board";
import { CrossRepositoryBoard, unavailableNote } from "./cross-repository-board";

const NONE = { unreadable: 0, truncated: 0, repositories: 0, pullRequests: 0 } as const;

function row(overrides: Partial<CrossRepositoryRow> = {}): CrossRepositoryRow {
  return {
    repository: { owner: "acme", name: "web" },
    number: 7,
    title: "図を出す",
    updatedAt: "2026-09-11T00:00:00Z",
    href: "/repos/acme/web/pull/7",
    ...overrides,
  };
}

function render(props: Partial<CrossRepositoryBoardProps> = {}): string {
  return renderToStaticMarkup(
    createElement(CrossRepositoryBoard, { rows: [row()], unavailable: NONE, ...props }),
  );
}

describe("CrossRepositoryBoard", () => {
  it("どのリポジトリの行かが分かる", () => {
    // **跨ぐので、番号だけでは 1 本を指せない。**
    // **行き先にも名前が入る**ので、**本文へ `toContain` すると、名前を出す札を
    // 消しても緑のまま**になる（#620 の形。**変異で踏んだ**）——**札そのものを見る**
    const html = render();

    expect(html, "どのリポジトリの行かが出ていない").toMatch(/<span[^>]*>acme\/web<\/span>/);
    expect(html).toContain("#7");
    expect(html).toContain("図を出す");
  });

  it("取れた時刻を、そのまま出す", () => {
    // **「新しい」とは言わない**（#664）
    expect(render()).toContain("2026-09-11T00:00:00Z");
  });

  it("「分からない」を「依頼なし」と出さない", () => {
    // **材料が読めなかった行**（#681 は `undefined` で返す）
    const html = render({ rows: [row({ assignment: undefined })] });

    expect(html).toContain("読めませんでした");
    expect(html, "読めなかったものを「誰にも振られていません」と出している").not.toContain(
      "誰にも振られていません",
    );
  });

  it("読めたぶんを出したうえで、読めなかった数も出す", () => {
    const html = render({
      unavailable: { unreadable: 2, truncated: 1, repositories: 3, pullRequests: 4 },
    });

    expect(html, "読めたぶんまで消している").toContain("#7");
    expect(html).toContain("2 件は読めませんでした");
    expect(html).toContain("1 件は多すぎて読み切れませんでした");
    expect(html).toContain("3 件はリポジトリの一覧の時点で読めませんでした");
    expect(html, "形の読めなかった PR が消えている").toContain(
      "4 本は、PR の形を読み取れませんでした",
    );
  });

  it("読めなかったものが無ければ、その行は出ない", () => {
    // **平常時に鳴る行は、そのうち読まれなくなる**（#248）
    expect(unavailableNote(NONE)).toBeUndefined();
    expect(render()).not.toContain("読めませんでした。");
  });

  it("跨がないものを出さない", () => {
    // **依存グラフ・Tier・同じファイルを触る組・重複**（#662）
    // ——**材料そのものを持っていない**ので、**出そうとすると往復が増えると気づける**
    const html = render({
      rows: [
        row({
          opinion: { approvesHead: true, changesRequestedOnHead: false, reviewed: true },
          mergeStatus: { mergeable: "mergeable", state: "clean" },
          assignment: { assignees: [], reviewers: [], authoredByBot: false },
        }),
      ],
    });

    for (const forbidden of ["Tier", "依存", "先に", "重な", "同じファイル"]) {
      expect(html, `${forbidden} が出ている`).not.toContain(forbidden);
    }
  });

  it("依存が分からないので、「マージする人の番」とは言わない", () => {
    // **跨がないので、先に入れる PR が残っているかは分からない**
    // ——**`ballOf` は合流できることと依存が無いことの両方を要る**
    const html = render({
      rows: [
        row({
          opinion: { approvesHead: true, changesRequestedOnHead: false, reviewed: true },
          mergeStatus: { mergeable: "mergeable", state: "clean" },
          assignment: { assignees: ["hana"], reviewers: [], authoredByBot: false },
        }),
      ],
    });

    expect(html, "依存を見ていないのに「いま入れられます」と言っている").not.toContain(
      "いま入れられます",
    );
  });

  it("1 本も無ければ、そう言う", () => {
    // **空の一覧を、黙って出さない**（#410 の線）
    // **`toContain` は、断定していない側の文にも当たる**
    // （`読めたぶんに、open な PR はありません。`）——**段落ごと見る**
    expect(render({ rows: [] })).toContain(">open な PR はありません。</p>");
  });

  it("読めていない範囲が残るなら、0 件と断定しない", () => {
    // **読めなかったリポジトリに open PR がある可能性が残る**（#686 のレビュー）
    // ——**「読めませんでした」と言った直後に「ありません」と断定すると、
    // 同じ画面が逆のことを言う**
    const html = render({
      rows: [],
      unavailable: { unreadable: 1, truncated: 0, repositories: 0, pullRequests: 0 },
    });

    expect(html, "読めていないのに 0 件と断定している").not.toContain(
      ">open な PR はありません。</p>",
    );
    expect(html).toContain("読めたぶんに、open な PR はありません。");
  });

  it("形の読めなかった PR だけが残るときも、0 件と断定しない", () => {
    const html = render({
      rows: [],
      unavailable: { unreadable: 0, truncated: 0, repositories: 0, pullRequests: 2 },
    });

    expect(html).not.toContain(">open な PR はありません。</p>");
  });
});

/**
 * **誰の番かで絞る**（#683）。
 *
 * **1 リポジトリの盤面（#663）と同じ口**である——**別の並びを作らない。**
 */
describe("横断の一覧を、誰の番かで絞る", () => {
  /** **#1 は著者の番**（変更が求められている）、**#2 はレビューする人の番。** */
  const AUTHOR = row({
    repository: { owner: "acme", name: "web" },
    number: 1,
    opinion: { approvesHead: false, changesRequestedOnHead: true, reviewed: true },
    assignment: { assignees: [], reviewers: [], authoredByBot: false },
  });
  const REVIEWER = row({
    repository: { owner: "acme", name: "api" },
    number: 2,
    opinion: { approvesHead: false, changesRequestedOnHead: false, reviewed: true },
    assignment: { assignees: [], reviewers: ["r"], authoredByBot: false },
  });

  /** **一覧の中だけ**——**絞りの口も断りも外に出る**ので、本文で数えない */
  function list(markup: string): string {
    const from = markup.indexOf("<ul");
    return from < 0 ? "" : markup.slice(from, markup.indexOf("</ul>", from));
  }

  it("渡された絞りが、一覧に効く", () => {
    const html = render({ rows: [AUTHOR, REVIEWER], ballFilter: "author" });

    expect(list(html)).toContain("acme/web");
    expect(list(html), "絞りに当たらない行が残っている").not.toContain("acme/api");
  });

  it("渡されなければ、絞らない", () => {
    const html = render({ rows: [AUTHOR, REVIEWER] });

    expect(list(html)).toContain("acme/web");
    expect(list(html)).toContain("acme/api");
  });

  it("絞っても、読めなかった件数は出る", () => {
    // **読めなかったものは絞りの外**（#663 の「気をつけること」）——**混ぜると、
    // 抜けが絞りのせいに見える**
    const html = render({
      rows: [AUTHOR, REVIEWER],
      ballFilter: "author",
      unavailable: { ...NONE, unreadable: 3 },
    });

    expect(html, "絞ると読めなかった件数が消える").toContain("3 件は読めませんでした");
  });

  it("絞って 0 件と、1 件も無いを言い分ける", () => {
    // **#410 が `EmptyNotice` で塞いだ形**——**「ありません」だけだと、
    // 絞ったせいなのか、本当に無いのかが分からない**
    const filtered = render({ rows: [AUTHOR], ballFilter: "merger" });
    const empty = render({ rows: [] });

    expect(filtered, "絞って 0 件なのに「open な PR はありません」と言っている").not.toContain(
      "open な PR はありません",
    );
    expect(filtered, "隠した件数を言っていない").toContain("1 件を隠しています");
    expect(empty).toContain("open な PR はありません");
  });

  it("絞る口は、絞っていなくても出る", () => {
    // **無ければ、絞れることに気づけない**（`BallFilterView` の但し書き）
    expect(render({ rows: [AUTHOR] })).toContain("誰の番かで絞る");
  });
});

/**
 * **並びは、最後に動いたものから**（#683）。
 *
 * **根拠は `crossReviewOrder` が持つ**——**ここで見るのは「その順で出ていること」**
 * だけである（**繋ぎ忘れても、domain の試験は緑のまま**）。
 */
describe("横断の一覧の並び", () => {
  it("最後に動いたものから出る", () => {
    const html = render({
      rows: [
        row({
          repository: { owner: "a", name: "old" },
          number: 1,
          updatedAt: "2026-01-01T00:00:00Z",
        }),
        row({
          repository: { owner: "b", name: "new" },
          number: 2,
          updatedAt: "2026-03-01T00:00:00Z",
        }),
      ],
    });

    expect(html.indexOf("b/new"), "動いたものが下にある").toBeLessThan(html.indexOf("a/old"));
  });
});

/**
 * **読めていない範囲が残るなら、絞り結果を断定しない**（#694 のレビュー）。
 *
 * **#686 のレビューが空表示で塞いだのと同じ形**である——**「読めませんでした」と
 * 言った直後に「ありません」と言うと、同じ画面が逆のことを言う。**
 */
describe("絞って 0 件のとき、読めなかったものが残る", () => {
  const ROW = row({
    opinion: { approvesHead: false, changesRequestedOnHead: true, reviewed: true },
    assignment: { assignees: [], reviewers: [], authoredByBot: false },
  });

  it("無いとは言い切らない", () => {
    const html = render({
      rows: [ROW],
      ballFilter: "merger",
      unavailable: { ...NONE, truncated: 1 },
    });

    expect(html, "読めていない範囲があるのに言い切っている").toContain("読めた範囲");
  });

  it("読めなかったものが無ければ、これまでどおり言い切る", () => {
    const html = render({ rows: [ROW], ballFilter: "merger", unavailable: NONE });

    expect(html, "読めているのに限定している").not.toContain("読めた範囲");
  });
});

/**
 * **判定できなかった行を、無いことにしない**（#694 のレビュー 2 周目）。
 */
describe("判定できなかった行があるとき", () => {
  /** **材料が揃っている行**（著者の番）。 */
  const DECIDED = row({
    repository: { owner: "acme", name: "web" },
    number: 1,
    opinion: { approvesHead: false, changesRequestedOnHead: true, reviewed: true },
    assignment: { assignees: [], reviewers: [], authoredByBot: false },
  });
  /** **`assignment` を読めなかった行**——**`ballOf` は `unknown` へ倒す。** */
  const UNDECIDED = row({
    repository: { owner: "acme", name: "api" },
    number: 2,
    opinion: { approvesHead: false, changesRequestedOnHead: false, reviewed: true },
  });

  it("一覧に出ていても、分からない行があれば言い切らない", () => {
    // **行は並んでいるので「盤面に出ていない」では数えられない**——**それでも、
    // 本当はその番だったかもしれない**
    const html = render({ rows: [DECIDED, UNDECIDED], ballFilter: "reviewer" });

    expect(html, "分からない行があるのに言い切っている").toContain("読めた範囲");
  });

  it("全部が判定できるなら、言い切る", () => {
    const html = render({ rows: [DECIDED], ballFilter: "reviewer" });

    expect(html, "判定できているのに限定している").not.toContain("読めた範囲");
  });

  it("「マージする人の番」は選択肢に出さない", () => {
    // **依存を跨がないので、この画面では構造的に出ない**（`CROSS_BALL_FILTERS`）
    // ——**押すと必ず 0 件になる選択肢**である
    const html = render({ rows: [DECIDED] });

    // **札の文字で見ない**（`AGENTS.md` §4。**数えた**——**「レビューする人の番」は
    // 選択肢と断りの 2 箇所に出る**ので、**選択肢が消えても断りに当たって緑**になる）。
    // **選択肢そのものの行き先**（`?ball=…`）**で見る**——**そこにしか無い**
    expect(html, "判定できない選択肢を出している").not.toContain("?ball=merger");
    expect(html, "他の選択肢まで消えている").toContain("?ball=reviewer");
  });
});
