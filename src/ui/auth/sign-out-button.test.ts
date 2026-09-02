/**
 * **画面からログアウトする**（#563）。
 *
 * **入れるが出られない**——**`/auth/logout` は POST だけを受ける**のに、
 * **その POST を出すものが画面に 1 つも無かった。**
 *
 * **口の作りは崩さない**（**GET で消せると `<img src>` 1 つで他人を
 * ログアウトさせられる**）ので、**押す側が POST を出す。**
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SignOutButtonProps } from "./sign-out-button";
import { SignOutButton, showsSignOut } from "./sign-out-button";

function render(props: SignOutButtonProps): string {
  return renderToStaticMarkup(createElement(SignOutButton, props));
}

const ACTION = "/auth/logout";

describe("ログアウトのボタン", () => {
  it("POST で出す", () => {
    // **GET のリンクにしない。** **リンクにすると口の作りを崩すことになる**
    // ——**405 が返る形は、他人をログアウトさせられないためにある。**
    const html = render({ action: ACTION });

    expect(html).toContain('method="post"');
    expect(html).toContain(`action="${ACTION}"`);
  });

  it("リンクではない", () => {
    // **上の判定を支える。** **`<a href>` で出すと、`method="post"` は
    // どこにも出ないまま「押せる」ものが画面に載る**
    const html = render({ action: ACTION });

    expect(html).not.toContain("<a ");
    expect(html).toContain('type="submit"');
  });

  it("誰から出るのかを添えられる", () => {
    // **必須ではない**（Issue の 3 つ目は「あるとよい」）——**出せることだけ見る**
    expect(render({ action: ACTION, signedInAs: "octocat" })).toContain("octocat");
  });

  it("分からなければ、名乗らせない", () => {
    // **空の名前を「誰か」として出さない**——**「 さん」だけが出る**
    expect(render({ action: ACTION })).not.toContain("さん");
  });
});

describe("どの画面で出すか", () => {
  /**
   * **いちばん大事なのは、期限切れのとき**である (#563)。
   *
   * **GitHub の token は 8 時間で切れる**が、**Supabase のセッションはもっと長く
   * 生きる**——**その差の間、人は「入っているのに何もできない」状態になる。**
   * **そこで出せないと、この Issue が塞ぎに来た穴がそのまま残る。**
   */
  it("期限が切れているときに出す", () => {
    expect(showsSignOut("needs-login")).toBe(true);
  });

  it("見えているときにも出す", () => {
    // **入口（`listed`）と盤面（`board`）で語が違う**——**どちらも出す**
    expect(showsSignOut("listed")).toBe(true);
    expect(showsSignOut("board")).toBe(true);
  });

  it("ログインしていない人には出さない", () => {
    // **畳むセッションが無い**（`store` が無いときだけこの語になる）
    expect(showsSignOut("signed-out")).toBe(false);
  });

  it("故障のときは出さない", () => {
    // **入り直しても直らない**（`unavailable` は置き場を開けなかった側）——
    // **出すと、故障を認証切れとして案内することになる**（画面が
    // 「ログインへ」を出さないのと同じ判断）
    expect(showsSignOut("unavailable")).toBe(false);
  });

  it("知らない状態では、出すほうへ倒す", () => {
    // **倒れる向きを選ぶ。** **出して困るのは、押しても何も消えない 1 回**だが、
    // **出し損ねると、詰まった人に打つ手が無い**——**この Issue そのものである。**
    expect(showsSignOut("some-new-kind")).toBe(true);
  });
});
