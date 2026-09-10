import { describe, expect, it } from "vitest";
import { boardReloadHref } from "./board-reload-href";

/** **「さっき押した結果」の断りが載る鍵**（呼ぶ側が渡す。#664 のレビュー 2 周目）。 */
const OUTCOMES = ["approve", "merge", "plan", "plan-at"];

describe("引き直す先を組む", () => {
  it("問い合わせが無ければ、空の問い合わせにする", () => {
    // **`?` だけでも、いまの道をもう一度開き直せる**——**行き先を渡さずに済む**
    expect(boardReloadHref({}, OUTCOMES)).toBe("?");
  });

  it("いまの問い合わせを持ったまま開き直す", () => {
    // **引き直したら全部出てきた、では絞った意味が消える**（#663）
    expect(boardReloadHref({ ball: "author" }, OUTCOMES)).toBe("?ball=author");
  });

  it("渡された鍵だけを落とす", () => {
    // **落とす鍵は呼ぶ側が持つ**（#664 のレビュー 2 周目）——**断りを読む側と
    // 同じ集合**である。**ここに並べると、断りが 1 つ増えた日に片方だけ古くなる**
    expect(
      boardReloadHref({ plan: "not-approved", "plan-at": "2", ball: "author" }, OUTCOMES),
    ).toBe("?ball=author");
    expect(
      boardReloadHref({ plan: "not-approved" }, ["approve"]),
      "渡していない鍵まで落としている",
    ).toBe("?plan=not-approved");
  });

  it("直前の結果の断りは持ち越さない", () => {
    // **`?approve=` / `?merge=` は「さっき押した結果」**である——**引き直しで
    // 持ち越すと、押していないのに同じ断りがもう一度出る**
    expect(
      boardReloadHref({ approve: "denied", merge: "conflict", ball: "author" }, OUTCOMES),
    ).toBe("?ball=author");
  });

  it("同じ鍵が 2 つ載っていたら、その鍵は持ち越さない", () => {
    // **どちらを選んでも、URL と画面が食い違う**（`ballFilterOf` と同じ判断）
    expect(boardReloadHref({ ball: ["author", "merger"] }, OUTCOMES)).toBe("?");
  });

  it("値をそのまま繋がない", () => {
    // **問い合わせの値は、誰でも好きな文字列を入れられる**（§6）——**繋ぐ前に逃がす**
    expect(boardReloadHref({ ball: "a&b=c" }, OUTCOMES)).toBe("?ball=a%26b%3Dc");
  });
});
