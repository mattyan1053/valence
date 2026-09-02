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
