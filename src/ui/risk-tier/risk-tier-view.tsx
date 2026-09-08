/**
 * リスク Tier を表示する。
 *
 * **判定はしない。** `classifyRiskTier` が返した Tier と、その判断材料を受け取って出す。
 * **Tier の名前だけを出さない**——なぜその Tier なのかが分からないと、レビュアーは
 * **判定を検算できない**。ルールベースであることの価値は、**理由が追えること**にある。
 *
 * **依存グラフの各行に載せられるよう、見出しを持たない。** 置き場所は呼ぶ側が決める。
 */

import type { ReportableChangeKind } from "../../domain/triage/change-kind";
import { reportableKindOf } from "../../domain/triage/change-kind";
import type { CiFailureScope } from "../../domain/triage/ci-attribution";
import { ciFailureScopeOf } from "../../domain/triage/ci-attribution";
import type { ChangeSummary, CiStatus, RiskTier } from "../../domain/triage/risk-tier";
import { touchesSensitivePath } from "../../domain/triage/sensitive-path";

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
 * 変更の種類（#640）。**「読まなくていい」とは書かない。**
 *
 * **仕分けは「どう読むか」を変えるもの**である——**`#625`（Dependabot）は
 * `package.json` と `pnpm-lock.yaml` だけの機械的な変更**だったが、**版が
 * `biome.json` にもあり、そちらがずれて CI が落ちた。** **「deps だから読まなくていい」
 * ではない**ので、**どこを見るかだけを言う。**
 *
 * **Tier には効かない**（`classifyRiskTier` はここを見ない）——**種類は「何をする PR か」**、
 * **危なさは「壊れたときの影響」**である。
 *
 * **`Record` で持つ**（`TIER_TEXT` と同じ）——**種類を足したときに書き忘れると、
 * 型検査が落ちる。**
 */
const KIND_TEXT: Record<ReportableChangeKind, string> = {
  deps: "依存の更新だけです（版を持つ別のファイルとずれていないか）",
  docs: "ドキュメントだけです",
  test: "テストだけです",
  generated: "生成物だけです（生成元も一緒に変わっているか）",
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
 * 落ちている CI の出どころ（#638）。**マージ先が赤いと、その上の PR は全部赤くなる。**
 *
 * **`Record` で持つ**（`TIER_TEXT` と同じ）——**状態を足して書き忘れると型検査が落ちる。**
 *
 * **`only-here` は `undefined`。** **既定の文言（`CI: 落ちています（直さないと
 * 進みません）`）が、そのまま答えになっている**ので、**同じことを 2 度言わない。**
 * **「この PR のせいだ」とも言い切らない**——**この PR の check が走ったのは、
 * マージ先を読んだ瞬間とは別の瞬間**である。**マージ先が直ったあとの赤**は
 * ここへ来るが、**そこで言えるのは「いまのマージ先には出ていない」までで、
 * 誰のせいかではない。**
 */
const SCOPE_TEXT: Record<CiFailureScope, string | undefined> = {
  "also-on-base": "マージ先でも同じ check が落ちています",
  "only-here": undefined,
  unmeasured: "マージ先と突き合わせられませんでした",
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
  // **言ってよいかは domain が決める**（#640）——**混ざっているとき・最後まで
  // 読めていないとき・実装だけのときは `undefined` が返る。**
  const kind = reportableKindOf(change.changedPaths);
  // **落ちていなければ `undefined`**（`ciFailureScopeOf`）——**通っている行に
  // 突き合わせの話は出ない。** **判定はここに書き写さない。**
  const scope = ciFailureScopeOf(change.failingChecks, change.baseCi);
  const scopeText = scope === undefined ? undefined : SCOPE_TEXT[scope];

  return (
    // **判断材料は脇に置く**（#583）。**本文と同じ強さで並ぶと、行が読めない。**
    // **畳みと組み合わせる**（#597）——**常時見えるのは札と、普通でない CI だけ**で、
    // **色と大きさは、開いたときの中身にも掛ける。**
    //
    // **`gap` を足したいまも、文字の区切りは残す**——**class が出ていなくても
    // 読める形を、試験が守っている。**
    <details className="text-sm">
      {/* **`summary` に `display:flex` を掛けない**——**開閉の三角（marker）が消える**。
       **間隔は文字の区切りが持っている**ので、class は要らない。 */}
      <summary>
        <strong className="font-semibold">{text.label}</strong>
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
        {/* **出どころも、開かずに見せる**（#638）——**マージ先から来た赤なら、
            開くまでもなく「ここは追わなくてよい」と分かる。**
            **区切りは上と同じく文字で置く**（class に頼らない。#605 のレビュー）。 */}
        {scopeText !== undefined && (
          <>
            <span aria-hidden="true">／</span>
            <span>{scopeText}</span>
          </>
        )}
      </summary>
      <p className="text-[var(--muted)]">{text.meaning}</p>
      <ul className="flex list-disc flex-col gap-0.5 pl-5 text-[var(--muted)]">
        <li>
          変更: {change.changedFileCount} ファイル / {change.changedLineCount} 行
        </li>
        {!ciNeedsAttention && <li>{CI_TEXT[change.ciStatus]}</li>}
        {kind !== undefined && <li>{KIND_TEXT[kind]}</li>}
        {touchesSensitivePath(change.changedPaths.paths) && (
          <li>壊すと影響が大きいパスに触れています</li>
        )}
      </ul>
    </details>
  );
}
