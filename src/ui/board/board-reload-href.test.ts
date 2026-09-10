import { describe, expect, it } from "vitest";
import { boardReloadHref } from "./board-reload-href";

describe("引き直す先を組む", () => {
  it("問い合わせが無ければ、空の問い合わせにする", () => {
    // **`?` だけでも、いまの道をもう一度開き直せる**——**行き先を渡さずに済む**
    expect(boardReloadHref({})).toBe("?");
  });

  it("いまの問い合わせを持ったまま開き直す", () => {
    // **引き直したら全部出てきた、では絞った意味が消える**（#663）
    expect(boardReloadHref({ ball: "author" })).toBe("?ball=author");
  });

  it("直前の結果の断りは持ち越さない", () => {
    // **`?approve=` / `?merge=` は「さっき押した結果」**である——**引き直しで
    // 持ち越すと、押していないのに同じ断りがもう一度出る**
    expect(boardReloadHref({ approve: "denied", merge: "conflict", ball: "author" })).toBe(
      "?ball=author",
    );
  });

  it("同じ鍵が 2 つ載っていたら、その鍵は持ち越さない", () => {
    // **どちらを選んでも、URL と画面が食い違う**（`ballFilterOf` と同じ判断）
    expect(boardReloadHref({ ball: ["author", "merger"] })).toBe("?");
  });

  it("値をそのまま繋がない", () => {
    // **問い合わせの値は、誰でも好きな文字列を入れられる**（§6）——**繋ぐ前に逃がす**
    expect(boardReloadHref({ ball: "a&b=c" })).toBe("?ball=a%26b%3Dc");
  });
});
