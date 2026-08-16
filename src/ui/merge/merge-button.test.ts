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

const ACTION = "/repos/acme/web/merge";

describe("Merge のボタン", () => {
  it("どの PR をマージするのかを、送る先が持っている", () => {
    const html = render({ number: 42, action: ACTION });

    expect(html).toContain('method="post"');
    expect(html).toContain(ACTION);
    expect(html).toContain('value="42"');
  });

  it("できないと分かっているときは、押せない", () => {
    expect(render({ number: 42, action: ACTION, disabled: true })).toContain("disabled");
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
