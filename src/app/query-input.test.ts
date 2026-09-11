/**
 * **URL から来る値の受け口**（#696）。
 *
 * **`AGENTS.md` §6 は「クエリパラメータは Zod で検証してから使う」**と書いている。
 * **この口はその 1 箇所**で、**画面はここを通してから使う。**
 */

import { describe, expect, it } from "vitest";
import { allowedValueFrom, pullRequestNumberFrom } from "./query-input";

describe("並べたものだけを通す", () => {
  const OPTIONS = ["forbidden", "unavailable"] as const;

  it("並びにある語を通す", () => {
    expect(allowedValueFrom("forbidden", OPTIONS)).toBe("forbidden");
  });

  it("並びに無い語は通さない", () => {
    // **URL から渡ってくる**ので、**利用者が任意に作れる**
    expect(allowedValueFrom("いたずら", OPTIONS)).toBeUndefined();
  });

  it("同じ鍵が 2 つ載っていたら通さない", () => {
    // **配列で来る**——**片方を選ぶと、URL と画面が食い違う**
    expect(allowedValueFrom(["forbidden", "unavailable"], OPTIONS)).toBeUndefined();
  });

  it("語でないものは通さない", () => {
    for (const value of [undefined, 7, null, {}]) {
      expect(allowedValueFrom(value, OPTIONS), String(value)).toBeUndefined();
    }
  });
});

describe("PR の番号だけを通す", () => {
  it("形で絞ってから数にする", () => {
    expect(pullRequestNumberFrom("42")).toBe(42);
    expect(pullRequestNumberFrom(" 42 ")).toBe(42);
  });

  it("`Number()` が受けるだけの形は通さない", () => {
    // **`1e3` も `0x2a` も `Number()` は受ける**——**通してよいものを並べる側で決める**
    for (const value of ["1e3", "0x2a", "", " ", "-1", "0", "1.5", "٤٢"]) {
      expect(pullRequestNumberFrom(value), value).toBeUndefined();
    }
  });

  it("数でないもの・そもそも文字列でないものを通さない", () => {
    // **黙って `NaN` を渡さない**——**どの PR とも違う相手へ要求が出る**
    // **受け口ごと移したので、移す前が見ていた形もここで見る**（#696。§5）
    for (const value of ["abc", "4 2", null, undefined, 42, {}]) {
      expect(pullRequestNumberFrom(value), String(value)).toBeUndefined();
    }
  });

  it("安全に扱えない大きさは通さない", () => {
    expect(pullRequestNumberFrom("9007199254740993")).toBeUndefined();
  });
});
