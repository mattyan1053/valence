import { describe, expect, it } from "vitest";
import { type ChangeSummary, classifyRiskTier } from "./risk-tier";

/** 各テストが関心のある項目だけを上書きできるようにするための土台。 */
function summary(overrides: Partial<ChangeSummary> = {}): ChangeSummary {
  return {
    changedFileCount: 1,
    changedLineCount: 10,
    touchesSensitivePath: false,
    ciStatus: "passing",
    ...overrides,
  };
}

describe("classifyRiskTier", () => {
  it("CI が落ちている PR は要注意になる", () => {
    expect(classifyRiskTier(summary({ ciStatus: "failing" }))).toBe("high-risk");
  });

  it("CI が落ちていれば、変更が小さくても要注意のままになる", () => {
    const tiny = summary({ ciStatus: "failing", changedFileCount: 1, changedLineCount: 1 });

    expect(classifyRiskTier(tiny)).toBe("high-risk");
  });

  it("機密性の高いパスに触れる PR は要注意になる", () => {
    expect(classifyRiskTier(summary({ touchesSensitivePath: true }))).toBe("high-risk");
  });

  it("CI が未完了の PR は fast-track にしない", () => {
    const tiny = summary({ ciStatus: "pending", changedFileCount: 1, changedLineCount: 1 });

    expect(classifyRiskTier(tiny)).toBe("needs-review");
  });

  it("CI が通っている小さな PR は fast-track になる", () => {
    expect(classifyRiskTier(summary({ changedFileCount: 3, changedLineCount: 50 }))).toBe(
      "fast-track",
    );
  });

  it("ファイル数がしきい値を 1 つ超えると fast-track から外れる", () => {
    expect(classifyRiskTier(summary({ changedFileCount: 4, changedLineCount: 50 }))).toBe(
      "needs-review",
    );
  });

  it("行数がしきい値を 1 つ超えると fast-track から外れる", () => {
    expect(classifyRiskTier(summary({ changedFileCount: 3, changedLineCount: 51 }))).toBe(
      "needs-review",
    );
  });

  it("変更が空でも CI さえ通っていれば fast-track になる", () => {
    expect(classifyRiskTier(summary({ changedFileCount: 0, changedLineCount: 0 }))).toBe(
      "fast-track",
    );
  });
});
