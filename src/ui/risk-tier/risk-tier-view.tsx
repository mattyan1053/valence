/**
 * リスク Tier を表示する。
 *
 * **判定はしない。** `classifyRiskTier` が返した Tier と、その判断材料を受け取って出す。
 * **Tier の名前だけを出さない**——なぜその Tier なのかが分からないと、レビュアーは
 * **判定を検算できない**。ルールベースであることの価値は、**理由が追えること**にある。
 *
 * **依存グラフの各行に載せられるよう、見出しを持たない。** 置き場所は呼ぶ側が決める。
 */

import type { ChangeSummary, CiStatus, RiskTier } from "../../domain/triage/risk-tier";

export type RiskTierViewProps = {
  readonly tier: RiskTier;
  /** **判断材料も受け取る。** Tier だけでは理由を出せない。 */
  readonly change: ChangeSummary;
};

/**
 * **`Record` で持つ。** Tier を足したときにここへ書き忘れると**型検査が落ちる**ので、
 * 「新しい Tier が名前も出ないまま画面に出る」ことが起きない。
 *
 * **説明は「何をすべきか」にとどめ、「なぜか」は書かない。** 理由は判断材料の行
 * （CI・変更規模・影響の大きいパス）が持っている。ここに理由を書くと、
 * **同じことを 2 箇所で言って片方が事実と違う**ことになる——`high-risk` は
 * 「CI が落ちている」でも「機密パスに触れている」でも成立するので、
 * 一方を名指しすると**成立していない理由を表示する**（#110 のレビュー指摘）。
 */
const TIER_TEXT: Record<RiskTier, { label: string; meaning: string }> = {
  "fast-track": { label: "すぐ通せる", meaning: "内容を読まずにマージしてよい大きさです" },
  "needs-review": { label: "通常のレビュー", meaning: "いつもどおり中身を読んでください" },
  "high-risk": { label: "先に人が見る", meaning: "マージの前に人が中身を確認してください" },
};

/**
 * **「通っていない」で束ねない。** `pending` は待てば済み、`failing` は直さないと
 * 進まない。**レビュアーにとって別の行動**なので、同じ見た目にすると
 * **待てばよいものを直しに行く**ことになる。
 */
const CI_TEXT: Record<CiStatus, string> = {
  passing: "CI: 通っています",
  pending: "CI: まだ終わっていません（待てば済みます）",
  failing: "CI: 落ちています（直さないと進みません）",
};

/**
 * **10 本並ぶと、全部読まないと順番が決まらない**（#597。**人が見て言った**）。
 *
 * > あとこれ数が増えたらめっちゃ見づらそう
 *
 * **走らせて数えた**——**10 本で 67 行、1 件あたり 6〜8 行。** **畳まれているものが
 * 1 つも無かった**ので、**「どれから見るか」を決めるのに全部読むことになる。**
 *
 * **常時見せるのは、順番を決める材料だけ**——**Tier の札と、CI が普通でないこと。**
 * **`passing` は 10 本のうちの大半で、背景である**（**出しても順番は決まらない**）。
 *
 * **消さない。** **理由が追えることが、ルールベースであることの価値**である
 * ——**`<details>` で畳むだけ**にする（**script が要らない**）。
 *
 * **CI の行は片方にしか置かない。** **常時出す側と畳む側の両方に書くと、
 * 同じことを 2 箇所で言うことになり、片方が事実と違う日が来る**（`TIER_TEXT` と同じ判断）。
 */
export function RiskTierView({ tier, change }: RiskTierViewProps) {
  const text = TIER_TEXT[tier];
  // **普通でない CI だけを、開かずに見せる**（**待つのか直すのかで、次の行動が違う**）
  const ciNeedsAttention = change.ciStatus !== "passing";

  return (
    <details>
      <summary>
        <strong>{text.label}</strong>
        {ciNeedsAttention && (
          <>
            {/* **区切りは文字で置く。** **`globals.css` は色とフォントだけ**で、
                **`summary` / `strong` / `span` の間隔を付ける規則が 1 つも無い**
                ——**JSX は行をまたぐ空白を削る**ので、**そのままだと
                `先に人が見るCI: 落ちています…` と繋がって読める**（#605 のレビュー）。
                **class で空けると、出ていなくても markup は同じ**なので、
                **試験では気づけない**（#585 で、配信中の CSS を見るまで分からなかった形）。 */}
            <span aria-hidden="true">／</span>
            <span>{CI_TEXT[change.ciStatus]}</span>
          </>
        )}
      </summary>
      <p>{text.meaning}</p>
      <ul>
        <li>
          変更: {change.changedFileCount} ファイル / {change.changedLineCount} 行
        </li>
        {!ciNeedsAttention && <li>{CI_TEXT[change.ciStatus]}</li>}
        {change.touchesSensitivePath && <li>壊すと影響が大きいパスに触れています</li>}
      </ul>
    </details>
  );
}
