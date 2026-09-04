import { describe, expect, it } from "vitest";
import { pullRequestPageUrl } from "./pull-request-page-url";
import { pathSegment } from "./repository-url";

describe("GitHub 上の場所を指す URL", () => {
  it("PR の画面を指す", () => {
    expect(pullRequestPageUrl({ owner: "o", name: "n" }, 42)).toBe(
      "https://github.com/o/n/pull/42",
    );
  });

  it("経路に効く文字を包む", () => {
    // **owner / name は経路から来る自由な文字列**である（#353 と同じ向き）。
    expect(pullRequestPageUrl({ owner: "a/b", name: "c?d" }, 1)).toBe(
      "https://github.com/a%2Fb/c%3Fd/pull/1",
    );
  });

  it("包んでも安全にならないものは、断る", () => {
    // **`..` は percent-encoded 形も dot segment として扱われる**ので、
    // **包んでも正規化で消える**（#353 で実測済み）。
    expect(() => pullRequestPageUrl({ owner: "..", name: "n" }, 1)).toThrow();
    expect(() => pullRequestPageUrl({ owner: "o", name: "." }, 1)).toThrow();
    expect(() => pathSegment(""), "空も区切りを消す").toThrow();
  });
});
