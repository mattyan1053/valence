/**
 * **1 クリックで Merge するボタン**（#331）。
 *
 * **押せなかった理由を出せること**が完了条件のひとつである
 * （**「押せたのに何も起きない」を作らない**）。
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MergeButtonProps } from "./merge-button";
import { MergeButton, mergeNotice } from "./merge-button";

function render(props: MergeButtonProps): string {
  return renderToStaticMarkup(createElement(MergeButton, props));
}

/**
 * **押せない状態か。**
 *
 * **`toContain("disabled")` では測れない**——**class に `disabled:opacity-50` が
 * 入っている**ので、**押せるときも通ってしまう**（実際に貫通していた）。
 * **属性そのものを見る。**
 */
function isDisabled(html: string): boolean {
  return html.includes('disabled=""');
}

const ACTION = "/repos/acme/web/merge";
const HEAD_SHA = "5e2a91c4d7f60b83ae15cd429f70b6d8e3a142cb";

describe("Merge のボタン", () => {
  it("どの PR をマージするのかを、送る先が持っている", () => {
    const html = render({ number: 42, action: ACTION, headSha: HEAD_SHA });

    expect(html).toContain('method="post"');
    expect(html).toContain(ACTION);
    expect(html).toContain('value="42"');
  });

  it("見せた commit を、送る本文が持つ", () => {
    // **押した対象を、見せた対象に固定する**（#331 のレビュー）
    const html = render({ number: 42, action: ACTION, headSha: HEAD_SHA });

    expect(html).toContain(`value="${HEAD_SHA}"`);
  });

  it("commit が分からなければ押せない", () => {
    // **確かめられない対象をマージさせない**——**押せると、盤面が見せていない
    // ものがマージされる**
    const html = render({ number: 42, action: ACTION, headSha: undefined });

    expect(isDisabled(html)).toBe(true);
    expect(html, "空の commit を送っている").not.toContain('name="sha"');
  });

  it("できないと分かっているときは、押せない", () => {
    expect(render({ number: 42, action: ACTION, headSha: HEAD_SHA, disabled: true })).toContain(
      "disabled",
    );
  });
});

describe("押せなかった理由を伝える", () => {
  it("権限が無いことと、PR が整っていないことを分ける", () => {
    // **権限を貰いに行くのか、PR を整えに行くのか**で次の行動が変わる
    expect(mergeNotice("forbidden")).not.toBe(mergeNotice("not-mergeable"));
  });

  it("整っていないときは、GitHub で確かめる先を示す", () => {
    // **理由をこちらで数え直さない**（#331）——**見に行く先を伝える**
    expect(mergeNotice("not-mergeable")).toContain("GitHub");
  });

  it("故障は、入り直しても直らないと分かる形で出す", () => {
    expect(mergeNotice("unavailable")).not.toContain("ログイン");
  });

  it("理由に、GitHub の文面をそのまま載せない", () => {
    for (const kind of ["forbidden", "not-mergeable", "unavailable"] as const) {
      expect(mergeNotice(kind)).not.toMatch(/status|Unprocessable|mergeable"/);
    }
  });
});

describe("依存が残っているときは押させない", () => {
  // **依存グラフを描く道具が、依存を壊せるボタンを持っていた**（#345）
  it("土台が残っていれば押せない", () => {
    const html = render({ number: 9, action: ACTION, headSha: HEAD_SHA, blockedBy: [8] });

    expect(isDisabled(html)).toBe(true);
  });

  it("何を先に入れればよいかを出す", () => {
    // **「押せない」だけでは、何をすればよいか分からない**（#345 の完了条件）
    const html = render({ number: 9, action: ACTION, headSha: HEAD_SHA, blockedBy: [8, 7] });

    expect(html).toContain("#8");
    expect(html).toContain("#7");
  });

  it("依存が無ければ、これまでどおり押せる", () => {
    const html = render({ number: 9, action: ACTION, headSha: HEAD_SHA, blockedBy: [] });

    expect(isDisabled(html)).toBe(false);
  });

  it("循環しているときは押せず、そう伝える", () => {
    const html = render({ number: 9, action: ACTION, headSha: HEAD_SHA, notOrderable: true });

    expect(isDisabled(html)).toBe(true);
    expect(html).toContain("循環");
  });
});

describe("押せなかった理由（依存）", () => {
  it("土台待ちと、順序が決められないことを分ける", () => {
    expect(mergeNotice("dependency-pending")).not.toBe(mergeNotice("not-orderable"));
  });

  it("土台待ちは、先に入れることが分かる文面になっている", () => {
    expect(mergeNotice("dependency-pending")).toContain("先に");
  });
});
