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

const NONE = { unreadable: 0, truncated: 0, repositories: 0 } as const;

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
    const html = render({ unavailable: { unreadable: 2, truncated: 1, repositories: 3 } });

    expect(html, "読めたぶんまで消している").toContain("#7");
    expect(html).toContain("2 件は読めませんでした");
    expect(html).toContain("1 件は多すぎて読み切れませんでした");
    expect(html).toContain("3 件はリポジトリの一覧の時点で読めませんでした");
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
    expect(render({ rows: [] })).toContain("open な PR はありません");
  });
});
