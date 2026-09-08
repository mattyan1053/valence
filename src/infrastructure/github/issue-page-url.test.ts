import { describe, expect, it } from "vitest";
import { issuePageUrl } from "./issue-page-url";

describe("issuePageUrl", () => {
  it("人が開く GitHub の場所を返す", () => {
    expect(issuePageUrl({ owner: "acme", name: "web" }, 7)).toBe(
      "https://github.com/acme/web/issues/7",
    );
  });

  it("経路へ入る名前を、そのまま繋がない", () => {
    // **判定は `repository-url.ts` が持つ**（写さない。`AGENTS.md` §5）
    expect(() => issuePageUrl({ owner: "..", name: "web" }, 7)).toThrow();
  });
});
