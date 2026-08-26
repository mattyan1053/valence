/**
 * **種類だけを言い、中身は 1 文字も出さない**（#248 / #506 の 2-b）。
 */

import { describe, expect, it } from "vitest";
import { errorKind } from "./error-kind";

class TokenError extends Error {}

describe("例外の種類だけを取る", () => {
  it("書いた人が付けたクラス名を返す", () => {
    expect(errorKind(new TokenError("secret-token-value"))).toBe("TokenError");
    expect(errorKind(new TypeError("x"))).toBe("TypeError");
  });

  it("中身は返さない", () => {
    // **`message` に応答本文がそのまま入っていることがある**（§6）
    expect(errorKind(new Error("ghp_realtokenlooking"))).not.toContain("ghp_");
  });

  it("Error でないものは、typeof までで止める", () => {
    // **`throw "文字列"` も `throw { token }` も書ける**
    expect(errorKind("ghp_realtokenlooking")).toBe("string");
    expect(errorKind({ token: "ghp_x" })).toBe("object");
    expect(errorKind(undefined)).toBe("undefined");
  });
});
