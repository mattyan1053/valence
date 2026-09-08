import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BaseCi, CheckSignal } from "../../domain/triage/ci-attribution";
import type { ChangeSummary, CiStatus, RiskTier } from "../../domain/triage/risk-tier";
import { classifyRiskTier } from "../../domain/triage/risk-tier";
import type { RiskTierViewProps } from "./risk-tier-view";
import { RiskTierView } from "./risk-tier-view";

function render(props: RiskTierViewProps): string {
  return renderToStaticMarkup(createElement(RiskTierView, props));
}

/** **domain の規則で当たるパス**（画面側で規則を書き直さない）。 */
const SENSITIVE_PATHS = {
  paths: ["src/infrastructure/github/app-jwt.ts"],
  truncated: false,
} as const;

/** 落ちている check の 1 件。**突き合わせるには名前が要る**（#638）。 */
const FAILED_CHECK: CheckSignal = { kind: "check-run", name: "test", outcome: "failure" };

function change(overrides: Partial<ChangeSummary> = {}): ChangeSummary {
  const ciStatus = overrides.ciStatus ?? "passing";
  return {
    changedFileCount: 2,
    changedLineCount: 20,
    changedPaths: { paths: ["src/ui/button.tsx"], truncated: false },
    ciStatus,
    // **`ciStatus` と食い違わせない。** 材料を作る側は**同じ判定から両方を出す**ので、
    // **「落ちているのに 1 件も挙がらない」入力は起こりえない**——
    // **起こりえない組み合わせで緑にしない**（この試験群がずっと守っている形）
    failingChecks: ciStatus === "failing" ? [FAILED_CHECK] : [],
    baseCi: undefined,
    ...overrides,
  };
}

/** マージ先の CI を添えた、落ちている PR。 */
function failingAgainst(baseCi: BaseCi | undefined): ChangeSummary {
  return change({ ciStatus: "failing", baseCi });
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
  "high-risk": change({ changedPaths: SENSITIVE_PATHS }),
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
    const touching = render({
      tier: "high-risk",
      change: change({ changedPaths: SENSITIVE_PATHS }),
    });
    const notTouching = render({
      tier: "high-risk",
      change: change({ changedPaths: { paths: ["src/ui/button.tsx"], truncated: false } }),
    });

    expect(touching).toMatch(/パスに触れ/);
    expect(touching).not.toBe(notTouching);
    expect(notTouching).not.toMatch(/パスに触れ/);
  });

  describe("変更の種類（#640）", () => {
    // **判定は `reportableKindOf` が持つ**（`AGENTS.md` §5）——**ここで見るのは、
    // 画面がその口へ繋がっているか**である。
    const depsOnly = change({
      changedPaths: { paths: ["package.json", "pnpm-lock.yaml"], truncated: false },
    });

    it("依存の更新だけなら、そう分かる", () => {
      // **#625 がこの形**である（**機械的だが、CI が落ちて人の手が要った**）
      expect(viewFor(depsOnly)).toMatch(/依存の更新だけ/);
    });

    it("「読まなくていい」とは書かない", () => {
      // **仕分けは「どう読むか」を変えるもの**である（#640）——**種類と危なさを
      // 混ぜると、deps を無条件で fast-track する。**
      const markup = viewFor(depsOnly);

      expect(markup).not.toMatch(/読まなくて|そのまま通して|安全/);
    });

    it("種類は Tier を変えない", () => {
      // **種類は「何をする PR か」、危なさは「壊れたときの影響」**である
      // ——**混ぜたら、ここで赤くする。**
      //
      // **影響が大きいパスを含まない組で比べる。** **`pnpm-lock.yaml` は
      // それ自体が `high-risk`** なので、**入れると「種類で変わった」と
      // 見分けが付かない。**
      // **`fast-track` になる大きさで比べない。** **どちらも `fast-track` なら、
      // 「docs なら通す」を足しても差が出ない**——**変異が素通りする**
      // （**実際に一度素通りした**）。**判定が割れる大きさで比べる。**
      const big = { changedFileCount: 9, changedLineCount: 300 };
      const docsOnly = change({
        ...big,
        changedPaths: { paths: ["README.md", "docs/adr/0001-why.md"], truncated: false },
      });
      const codeOnly = change({
        ...big,
        changedPaths: { paths: ["src/ui/button.tsx", "src/ui/other.tsx"], truncated: false },
      });

      expect(classifyRiskTier(docsOnly)).toBe("needs-review");
      expect(classifyRiskTier(docsOnly)).toBe(classifyRiskTier(codeOnly));
    });

    it("混ざっていたら、種類を出さない", () => {
      const mixed = change({
        changedPaths: { paths: ["package.json", "src/ui/button.tsx"], truncated: false },
      });

      expect(viewFor(mixed)).not.toMatch(/だけです/);
    });

    it("最後まで読めていないなら、種類を出さない", () => {
      // **「読めなかった」を「deps だけ」に化けさせない**（`AGENTS.md` §5）
      const truncated = change({
        changedPaths: { paths: ["package.json", "pnpm-lock.yaml"], truncated: true },
      });

      expect(viewFor(truncated)).not.toMatch(/だけです/);
    });
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

  /**
   * **10 本並ぶと、全部読まないと順番が決まらない**（#597。**人が見て言った**）。
   *
   * > あとこれ数が増えたらめっちゃ見づらそう
   *
   * **走らせて数えた**——**10 本で 67 行、1 件あたり 6〜8 行**（**Tier の説明文・
   * 変更の内訳・CI・機密パス・操作**）。**畳まれているものが 1 つも無かった。**
   *
   * **「どれから見るか」を決めるのに要るのは、Tier の札と、CI が普通でないこと**である
   * ——**残りは、その 1 本を開いてから読む。**
   *
   * **消さない**（`AGENTS.md`。**理由が追えることが、ルールベースの価値**である）
   * ——**畳むだけ**にする。**`<details>` は script 無しで開く。**
   *
   * **同じことを 2 箇所に出さない。** **CI の行は、常時出すか畳むかのどちらか**で、
   * **両方には置かない**——**片方が事実と違う日が来る**（`TIER_TEXT` の但し書きと同じ）。
   */
  describe("10 本並べても読めるように、畳む（#597）", () => {
    /** **常時見えている部分**（`<summary>` の中身）。 */
    function summaryOf(markup: string): string {
      const at = markup.indexOf("<summary");
      expect(at, "畳んでいない").toBeGreaterThanOrEqual(0);
      const from = markup.indexOf(">", at) + 1;
      const to = markup.indexOf("</summary>", from);
      expect(to, "summary が閉じていない").toBeGreaterThan(from);
      return markup.slice(from, to);
    }

    it("常時見えるのは、Tier の札である", () => {
      const markup = viewFor(REAL_CASES["high-risk"]);

      expect(summaryOf(markup), "札が畳まれている").toContain("先に人が見る");
    });

    it("畳んだ状態で始まる", () => {
      // **`<summary>` の中身だけを見ると、`<details open>` にしても全部緑になる**
      // ——**全行が初期表示に戻り、この Issue の症状がそのまま戻る**（#605 のレビュー）。
      //
      // **見るのは開始タグの属性**である——**中身ではなく、開いているかどうか。**
      const markup = viewFor(REAL_CASES["high-risk"]);
      const opened = [...markup.matchAll(/<details(\s[^>]*)?>/g)].map((found) => found[1] ?? "");

      expect(opened, "畳んでいない").toHaveLength(1);
      for (const attributes of opened) {
        expect(attributes, "開いた状態で始まっている").not.toMatch(/(^|\s)open(=|\s|$)/);
      }
    });

    it("Tier の説明文は、畳む", () => {
      // **10 本並ぶと、同じ Tier の行には同じ文が 10 回出る**——**順番を決める材料に
      // ならない。** **消しはしない**（開けば読める）。
      const markup = viewFor(REAL_CASES["high-risk"]);

      expect(summaryOf(markup), "説明文が常時出ている").not.toContain(
        "マージの前に人が中身を確認してください",
      );
      expect(markup, "説明文を消している").toContain("マージの前に人が中身を確認してください");
    });

    it("変更の内訳は、畳む", () => {
      const markup = viewFor(change({ changedFileCount: 7, changedLineCount: 120 }));

      expect(summaryOf(markup), "内訳が常時出ている").not.toContain("変更:");
      expect(markup, "内訳を消している").toContain("変更:");
    });

    it("CI が通っているときは、常時出さない", () => {
      // **10 本のうち 8 本が「CI: 通っています」なら、それは背景である。**
      const markup = viewFor(change({ ciStatus: "passing" }));

      expect(summaryOf(markup), "通っている CI が常時出ている").not.toContain("CI:");
      expect(markup, "通っている CI を消している").toContain("CI: 通っています");
    });

    it.each<CiStatus>(["failing", "pending"])("CI が %s なら、常時出す", (ciStatus) => {
      // **普通でないほうは、開かずに見えないと順番が決まらない。**
      const markup = viewFor(change({ ciStatus }));

      expect(summaryOf(markup), "普通でない CI が畳まれている").toContain("CI:");
    });

    it("Tier の札と CI の間に、区切りがある", () => {
      // **タグを外すと `先に人が見るCI: 落ちています…` と繋がって読める**
      // （#605 のレビュー）——**常時見せるようにした意味が減る。**
      //
      // **区切りは文字で置く。** **`globals.css` は色とフォントだけ**で、
      // **`summary` / `strong` / `span` の間隔を付ける規則が 1 つも無い**
      // ——**class に頼ると、出ていなくても markup は同じ**なので、
      // **試験では気づけない**（#585 で、配信中の CSS を見るまで分からなかった形）。
      // **タグは空白へ置き換える**（**この試験群の他の 4 箇所と同じ形**）。
      // **空文字にすると、CodeQL が「不完全なサニタイズ」として鳴る**
      // ——**`<` と後ろの語が繋がって読める形になるため**である（#605 のレビュー）。
      // **ここは出力を無害化しているのではなく、読める形を取り出しているだけ**だが、
      // **同じ書き方が 4 箇所で通っている**のだから、**そちらへ揃える。**
      const words = (markup: string) =>
        summaryOf(markup)
          .replace(/<[^>]*>/g, " ")
          .split(/\s+/)
          .filter(Boolean);

      expect(
        // **札は判定が決める**（`viewFor`）——**`failing` は `high-risk` になる**
        words(viewFor(change({ ciStatus: "failing" }))).slice(0, 3),
        "札と CI の間に区切りが無い",
      ).toEqual(["先に人が見る", "／", "CI:"]);
    });

    it("CI を出さない行に、区切りだけが残らない", () => {
      // **`passing` の行には CI が出ない**——**区切りだけが浮くと、何の区切りか読めない。**
      const summary = summaryOf(viewFor(change({ ciStatus: "passing" })));

      expect(summary, "区切りだけが残っている").not.toContain("／");
    });

    it("落ちている CI の出どころは、畳まない", () => {
      // **順番を決める材料である**（#638）——**マージ先から来た赤なら、
      // 開くまでもなく「ここは追わなくてよい」**と分かる
      const markup = viewFor(
        change({ ciStatus: "failing", baseCi: { settled: true, failing: [FAILED_CHECK] } }),
      );

      expect(summaryOf(markup), "出どころが畳まれている").toContain("マージ先でも");
    });

    it("CI の行は、常時出す側と畳む側の片方にしか無い", () => {
      // **同じことを 2 箇所で言うと、片方が事実と違う日が来る**（`TIER_TEXT` の但し書き）。
      for (const ciStatus of ["passing", "failing", "pending"] as const) {
        const markup = viewFor(change({ ciStatus }));

        expect(markup.split("CI:").length - 1, `${ciStatus} で CI の行が 2 つある`).toBe(1);
      }
    });
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

/**
 * **マージ先が赤いと、その上の PR は全部赤くなる**（#638）。
 * **「CI: 落ちています」としか言わないと、自分のせいでない失敗を全員が追いかける。**
 */
describe("落ちている CI の出どころ（#638）", () => {
  it("マージ先でも同じように落ちていれば、そう出す", () => {
    const markup = viewFor(failingAgainst({ settled: true, failing: [FAILED_CHECK] }));

    expect(markup).toContain("マージ先でも同じ check が落ちています");
  });

  it("突き合わせられなければ、そう言う", () => {
    // **「マージ先は緑」へ倒さない**——**倒すと、全部が自分のせいに見える**
    const markup = viewFor(failingAgainst(undefined));

    expect(markup).toContain("突き合わせられませんでした");
  });

  it("この PR にしか出ていないときは、マージ先の話をしない", () => {
    // **言い切るのは、同じ check が同じように落ちているときだけ**である。
    // **`CI: 落ちています（直さないと進みません）` が、そのまま答えになっている**
    const markup = viewFor(failingAgainst({ settled: true, failing: [] }));

    expect(markup).not.toContain("マージ先");
  });

  it("CI が落ちていない行には、突き合わせの話を出さない", () => {
    for (const ciStatus of ["passing", "pending"] as const) {
      expect(viewFor(change({ ciStatus })), `${ciStatus} に出ている`).not.toContain("マージ先");
    }
  });
});
