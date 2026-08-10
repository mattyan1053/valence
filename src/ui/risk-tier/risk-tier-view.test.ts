import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChangeSummary, CiStatus, RiskTier } from "../../domain/triage/risk-tier";
import { classifyRiskTier } from "../../domain/triage/risk-tier";
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
 * **判定を通して描く。** `tier` と `change` を別々に渡せると、
 * **実際には起こりえない組み合わせでも緑**になり、
 * 説明と判定がずれても気づけない（#110 のレビュー指摘）。
 */
function viewFor(change: ChangeSummary): string {
  return render({ tier: classifyRiskTier(change), change });
}

const TIERS: readonly RiskTier[] = ["fast-track", "needs-review", "high-risk"];

/** それぞれの Tier が**実際に成立する**入力。 */
const REAL_CASES: Record<RiskTier, ChangeSummary> = {
  "fast-track": change({ changedFileCount: 1, changedLineCount: 5 }),
  "needs-review": change({ changedFileCount: 9, changedLineCount: 300 }),
  "high-risk": change({ touchesSensitivePath: true }),
};

describe("RiskTierView", () => {
  it("どの Tier でも、それと分かる表示が出る", () => {
    // **表示の追加を忘れたら落ちる。** 型の側でも `Record<RiskTier, …>` が
    // 網羅を要求するので、Tier を足すと `pnpm typecheck` が落ちる
    // **判断材料を揃えて比べる。** 入力ごと変えると、
    // **Tier の文言が同じでも変更規模の行が違うので別物に見える**（実際にそうなった）
    const labels = TIERS.map((tier) => render({ tier, change: change() }));

    expect(new Set(labels).size).toBe(TIERS.length);
    for (const markup of labels) {
      expect(markup).not.toBe("");
    }
  });

  it("表示に使う入力が、実際にその Tier になる", () => {
    // **試験データが判定からずれないようにする。** ずれると、
    // 「起こりえない組み合わせ」を確かめているのに気づけない
    for (const tier of TIERS) {
      expect(classifyRiskTier(REAL_CASES[tier]), `${tier} が成立する入力になっていない`).toBe(tier);
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

  it("CI だけが落ちている小さな変更に、影響が大きいとは書かない", () => {
    // **`high-risk` は 2 通りの理由で成立する**（CI が落ちている / 機密パスに触れている）。
    // 成立していないほうを名指しすると、**画面の中で理由が食い違う**。
    // Tier の説明は「何をすべきか」にとどめ、「なぜか」は判断材料の行に任せる
    const markup = viewFor(
      change({ changedFileCount: 3, changedLineCount: 10, ciStatus: "failing" }),
    );

    expect(markup).toMatch(/落ちています/);
    expect(markup).not.toMatch(/影響が大きい/);
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
