/**
 * **「`code` が届いた」の意味を、1 箇所に置く**（#461）。
 *
 * **前は 2 箇所にあった。** **本物の受け口（`callback/route.ts`）は空を弾き**、
 * **必ず通る境界（`src/middleware.ts`）は `searchParams.has("code")` で見ていた**
 * ——**`/?code=` にも `true`** なので、**交換できる値が届いていなくても
 * 「戻ってこなかった」が 1 行残る。**
 *
 * **困るのは、その 1 行が「ログインが落ちたときに読む 1 行」だから**である
 * ——**誰でも `/?code=` を叩けば足せる**と、**本物の症状に混ざって数えられなくなる。**
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hasReceivedAuthorizationCode, receivedAuthorizationCode } from "./authorization-code";

const AUTH = fileURLToPath(new URL(".", import.meta.url));

describe("届いた認可コード", () => {
  it("値があれば、そのまま通す", () => {
    expect(receivedAuthorizationCode("7405c683")).toBe("7405c683");
    expect(hasReceivedAuthorizationCode("7405c683")).toBe(true);
  });

  it("前後の空白は落とす", () => {
    expect(receivedAuthorizationCode("  7405c683  ")).toBe("7405c683");
  });

  it("空文字は、届いていない", () => {
    // **`/?code=` の形**——**`has` は `true` を返す**
    expect(receivedAuthorizationCode("")).toBeUndefined();
    expect(hasReceivedAuthorizationCode("")).toBe(false);
  });

  it("空白だけも、届いていない", () => {
    expect(receivedAuthorizationCode("   ")).toBeUndefined();
    expect(hasReceivedAuthorizationCode("   ")).toBe(false);
  });

  it("そもそも無ければ、届いていない", () => {
    expect(receivedAuthorizationCode(null)).toBeUndefined();
    expect(hasReceivedAuthorizationCode(null)).toBe(false);
  });
});

describe("読み手が、両方ともこの口を通る", () => {
  /**
   * **振る舞いでは押さえられない側**（#461）。**本物の受け口が空を受けても、
   * 交換が落ちて入口へ戻る**ので、**外から見た応答は同じ**である
   * ——**「弾いたから戻った」と「試して落ちたから戻った」が区別できない。**
   *
   * **区別できるのは、口を通っているかどうか**である。**数えるのは呼び出し**——
   * **import しただけの形と分ける**（**呼び出しを消しても import は残る**）。
   */
  function timesUsed(relative: string, name: string): number {
    return readFileSync(`${AUTH}${relative}`, "utf8").split(`${name}(`).length - 1;
  }

  it("本物の受け口は、この口で `code` を読む", () => {
    expect(
      timesUsed("callback/route.ts", "receivedAuthorizationCode"),
      "受け口が、この口を通していない",
    ).toBeGreaterThanOrEqual(1);
  });

  it("必ず通る境界も、この口で見る", () => {
    // **`searchParams.has("code")` に戻ると、`/?code=` を「届いた」と数える**
    expect(
      timesUsed("../../middleware.ts", "hasReceivedAuthorizationCode"),
      "境界が、この口を通していない",
    ).toBeGreaterThanOrEqual(1);
  });
});
