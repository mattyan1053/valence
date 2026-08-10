import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChangeSummary, CiStatus, RiskTier } from "../../domain/triage/risk-tier";
import type { RiskTierViewProps } from "./risk-tier-view";
import { RiskTierView } from "./risk-tier-view";

function render(props: RiskTierViewProps): string {
  return renderToStaticMarkup(createElement(RiskTierView, props));
}

function change(overrides: Partial<ChangeSummary> = {}): ChangeSummary {
  return {
    changedFileCount: 2,
    changedLineCount: 20,
    touchesSensitivePath: false,
    ciStatus: "passing",
    ...overrides,
  };
}

/**
 * **表示側で並べる。** 判定は `classifyRiskTier` が持っているので、
 * ここでは「どの Tier が来ても、それと分かる表示が出るか」だけを見る。
 */
const TIERS: readonly RiskTier[] = ["fast-track", "needs-review", "high-risk"];

describe("RiskTierView", () => {
  it("どの Tier でも、それと分かる表示が出る", () => {
    // **表示の追加を忘れたら落ちる。** 型の側でも `Record<RiskTier, …>` が
    // 網羅を要求するので、Tier を足すと `pnpm typecheck` が落ちる
    const labels = TIERS.map((tier) => render({ tier, change: change() }));

    expect(new Set(labels).size).toBe(TIERS.length);
    for (const markup of labels) {
      expect(markup).not.toBe("");
    }
  });

  it("Tier の名前だけで終わらせない", () => {
    // **なぜその Tier なのかが分からないと、レビュアーは判定を検算できない。**
    // ルールベースであることの価値は、理由が追えることにある
    const markup = render({
      tier: "needs-review",
      change: change({ changedFileCount: 7, changedLineCount: 120 }),
    });

    expect(markup).toContain("7");
    expect(markup).toContain("120");
  });

  it("壊すと影響が大きいパスに触っていれば、それが分かる", () => {
    // **同じ Tier どうしで比べる。** 別の文（Tier の説明）に同じ語があるので、
    // 語の有無だけを見ると**この行を消しても緑のまま**になる（実際にそうなった）
    const touching = render({ tier: "high-risk", change: change({ touchesSensitivePath: true }) });
    const notTouching = render({
      tier: "high-risk",
      change: change({ touchesSensitivePath: false }),
    });

    expect(touching).toMatch(/パスに触れ/);
    expect(touching).not.toBe(notTouching);
    expect(notTouching).not.toMatch(/パスに触れ/);
  });

  describe("CI の状態", () => {
    function ciPartOf(ciStatus: CiStatus, tier: RiskTier): string {
      return render({ tier, change: change({ ciStatus }) });
    }

    it("待てば済むものと、直さないと進まないものを区別する", () => {
      // **同じ見た目にすると、待てばよいものを直しに行く。**
      // #107 で直した「触っても直らない PR の base を触らせる」と同じ形
      const pending = ciPartOf("pending", "needs-review");
      const failing = ciPartOf("failing", "high-risk");

      expect(pending).toMatch(/待て|待ち/);
      expect(failing).toMatch(/直/);
      expect(pending).not.toMatch(/直さないと/);
    });

    it.each<CiStatus>(["passing", "failing", "pending"])("%s と分かる表示が出る", (ciStatus) => {
      // **3 つとも別の見た目にする。** 1 つでも同じだと、そこで区別が消える
      const shown = ["passing", "failing", "pending"].map((status) =>
        ciPartOf(status as CiStatus, "needs-review"),
      );

      expect(new Set(shown).size).toBe(3);
      expect(ciPartOf(ciStatus, "needs-review")).not.toBe("");
    });
  });
});
