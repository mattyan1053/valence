/**
 * **1 クリックで Approve を出すボタン**（#330）。
 *
 * **表示に専念する**（§3）——**押した先で何が起きるかは知らない。**
 * **`action` は props で受ける**ので、**この部品は composition も application も
 * 見えない**（`ui-has-no-io`）。
 *
 * **押せなかった理由を出せること**が、この Issue の完了条件のひとつである。
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApproveButtonProps } from "./approve-button";
import { ApproveButton, approveNotice } from "./approve-button";

function render(props: ApproveButtonProps): string {
  return renderToStaticMarkup(createElement(ApproveButton, props));
}

const ACTION = "/repos/acme/web/approve";

describe("Approve のボタン", () => {
  it("どの PR に出すのかを、送る先が持っている", () => {
    // **番号を持たないボタンにしない**——**押した先で「どれ」が決まらないと、
    // 別の PR へ承認が出る**
    const html = render({ number: 42, action: ACTION });

    expect(html).toContain('method="post"');
    expect(html).toContain(ACTION);
    expect(html).toContain('value="42"');
  });

  it("出せないと分かっているときは、押せない", () => {
    // **押しても断られると分かっているなら、押させない**——
    // **理由は別に出す**（下）
    const html = render({ number: 42, action: ACTION, disabled: true });

    expect(html).toContain("disabled");
  });
});

describe("押せなかった理由を伝える", () => {
  it("権限が無いことと、自分の PR であることを分ける", () => {
    // **行き先が違うので、文面も分ける**——**権限を貰いに行くのか、
    // 他の人に頼むのか**で、押した人が次に取る行動が変わる
    expect(approveNotice("forbidden")).not.toBe(approveNotice("self-approval"));
  });

  it("自分の PR だと分かる文面になっている", () => {
    expect(approveNotice("self-approval")).toContain("自分");
  });

  it("故障は、入り直しても直らないと分かる形で出す", () => {
    // **再ログインへ案内すると、故障を認証切れとして隠す**（盤面と同じ判断）
    expect(approveNotice("unavailable")).not.toContain("ログイン");
  });

  it("承認できたことも出す", () => {
    expect(approveNotice("approved")).toContain("承認");
  });

  it("理由に、GitHub の文面をそのまま載せない", () => {
    // **§6。応答の中身には、そのユーザーの持ち物が並びうる**
    for (const kind of ["approved", "forbidden", "self-approval", "unavailable"] as const) {
      expect(approveNotice(kind)).not.toMatch(/status|Unprocessable|GitHub が/);
    }
  });
});
