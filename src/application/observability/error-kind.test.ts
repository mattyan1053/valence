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

describe("断られた状態コードは、名前に添える（#516）", () => {
  // **`message` は読まない**（§6。**応答本文が入っていることがある**）——**だから
  // 状態コードは、`message` ではないところに置く。** **こちらは「数値の欄があるか」
  // だけを見る**（**infrastructure のクラスを知らない**。§3）。

  class ApproveFailed extends Error {
    constructor(readonly status: number) {
      super(`GitHub が承認を受け付けませんでした (status ${status})`);
      this.name = "ApproveFailed";
    }
  }

  it("状態コードを持っていれば、名前のあとに添える", () => {
    expect(errorKind(new ApproveFailed(403))).toBe("ApproveFailed/403");
  });

  it("それでも中身は出さない", () => {
    class Leaky extends Error {
      readonly status = 422;
    }
    const error = new Leaky("ghp_realtokenlooking");

    expect(errorKind(error)).toBe("Leaky/422");
    expect(errorKind(error)).not.toContain("ghp_");
  });

  it("HTTP の状態コードでないものは添えない", () => {
    // **数値であっても、状態コードとして読めないものは通さない**——**別の意味の
    // 数**（件数・時刻・識別子）**が紛れ込むと、読む人が status だと信じる。**
    for (const status of [0, 99, 600, 1.5, Number.NaN, -403]) {
      const error = Object.assign(new Error("x"), { status });
      expect(errorKind(error), String(status)).toBe("Error");
    }
  });

  it("数値でない欄は見ない", () => {
    // **文字列を通すと、そこに何でも入れられる**（§6）。
    //
    // **数として読める文字列を置く**——**`"403 ghp_token"` だけだと、範囲の判定に
    // 引っかかって落ちる**ので、**型を見ているかどうかを測れない**（**変異で
    // 確かめた**：**型の判定を外しても緑のままだった**）。
    for (const status of ["403", "403 ghp_token"]) {
      const error = Object.assign(new Error("x"), { status });

      expect(errorKind(error), status).toBe("Error");
    }
  });
});
