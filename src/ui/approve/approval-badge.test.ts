/**
 * **承認済みかどうかを盤面に出す**（#343）。
 *
 * **押した結果は、盤面そのもので確かめる**——**成功はクエリ文字列に載らない**
 * （#342 のレビュー。**利用者が任意に作れる値から成功を断言しない**）。
 *
 * **「承認されていない」と「読めなかった」を分ける**——**同じ見た目にすると、
 * 押した人は「何も起きなかった」と読んでもう一度押す。**
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApprovalDisplayKind } from "./approval-badge";
import { ApprovalBadge, approvalLabel } from "./approval-badge";

function render(kind: ApprovalDisplayKind): string {
  return renderToStaticMarkup(createElement(ApprovalBadge, { kind }));
}

describe("承認の状態を出す", () => {
  it("承認済みだと分かる", () => {
    // **これが無いと、押した人は「何も起きなかった」と読む**
    expect(render("approved")).toContain("承認済み");
  });

  it("読めなかったことを、承認済みに見せない", () => {
    // **倒す向き。** **「承認済み」は取り消せない事実の主張**で、
    // **見た人はマージへ進む**——**分からないときは、そう言う**
    expect(render("unknown")).not.toContain("承認済み");
  });

  it("読めなかったことが、読めなかったと分かる", () => {
    // **黙って何も出さないと、「承認されていない」と見分けが付かない**
    expect(approvalLabel("unknown")).toMatch(/取得|読め|分かりません/);
  });

  it("2 つの状態を、同じ文面にしない", () => {
    expect(approvalLabel("approved")).not.toBe(approvalLabel("unknown"));
  });
});
