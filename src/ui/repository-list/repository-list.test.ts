/**
 * **ログインできていて 0 件のとき、入口の画面が何も言わない**（#415）。
 *
 * **判定が見出しに当たらないようにする**（#410 で踏んだ形。
 * **`toMatch(/PR/)` が `<h2>PR の依存</h2>` に当たっていた**）——**描いた本文で見る。**
 *
 * **`Home` は非同期のサーバコンポーネント**で、**描いて確かめる手立てが無い**
 * ——**倒し分けをこの部品へ置いてあるので、判定が届く。**
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RepositoryLink } from "./repository-list";
import { invalidNote, RepositoryList } from "./repository-list";

const render = (repositories: readonly RepositoryLink[], unreadable = 0) =>
  renderToStaticMarkup(createElement(RepositoryList, { repositories, unreadable }));

const link = (owner: string, name: string): RepositoryLink => ({
  owner,
  name,
  href: `/repos/${owner}/${name}`,
});

describe("読めなかったものを画面から消さない", () => {
  // **port が `invalid` を残しているのは、この最後の 1 歩のため**である
  // （**捨てると「読めなかった」が「見えなかった」に化ける**）——
  // **画面が `repositories` だけを描くと、そこで化ける**（#213 のレビュー）。
  it("読めなかったものがあれば、件数が出る", () => {
    expect(invalidNote(2)).toContain("2");
  });

  it("無ければ、何も出さない", () => {
    expect(invalidNote(0)).toBeUndefined();
  });

  it("理由は画面へ出さない", () => {
    // **Zod のメッセージには値が入りうる**（`app-credentials.ts` と同じ理由）
    expect(invalidNote(1)).not.toMatch(/expected|received|invalid_type/i);
  });

  it("並んでいても、件数は出る", () => {
    // **1 件でも読めなかったなら、並んだ一覧には抜けがある**
    expect(render([link("acme", "web")], 2), "抜けを黙って捨てている").toContain("2");
  });
});

describe("1 件も無いとき", () => {
  it("何が無いのかが出る", () => {
    expect(render([]), "空の一覧だけを出している").toMatch(/リポジトリが 1 件もありません/);
  });

  it("次に何をすればよいのかが出る", () => {
    // **App をインストールする**——**決まっているのだから、そう言う**
    expect(render([]), "次にすることが書かれていない").toMatch(/インストール/);
  });

  it("読めなかったせいで 0 件のときは、そう言わない", () => {
    // **0 件と「読めなかった」を同じ静けさにしない**（`AGENTS.md` §5）
    // ——**インストール済みなのに「インストールしてください」と言うことになる**
    const markup = render([], 2);

    expect(markup, "読めなかったのに「無い」と言っている").not.toMatch(/インストール/);
    expect(markup, "読めなかった件数が出ていない").toContain("2");
  });

  it("1 件でもあれば、断りは出さない", () => {
    const markup = render([link("acme", "web")]);

    expect(markup, "並んでいるのに「ありません」と言っている").not.toMatch(/ありません/);
    expect(markup, "リポジトリが並んでいない").toContain("acme/web");
  });

  it("行き先は、渡されたものをそのまま使う", () => {
    // **経路の組み立ては `app` が持つ**（`ui` は `app` を import できない）
    expect(render([link("acme", "web")]), "行き先が出ていない").toContain('href="/repos/acme/web"');
  });
});
