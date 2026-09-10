/**
 * **マージ順のプランを、1 クリックで流すボタン**（#661）。
 *
 * **表示に専念する**（§3）。**送る先は props で受ける。**
 *
 * **1 本ずつ押す道は残す**（#661 の完了条件）——**まとめて流すのが常に正しいとは
 * 限らない**ので、**`MergeButton` は行に置いたままにする。**
 */

import type { DependencyOrder } from "../../domain/graph/dependency-order";

/**
 * 流す 1 本。**commit まで持つ**（#331）——**押した対象を、盤面が見せた対象に固定する。**
 */
export type MergePlanStepView = {
  readonly number: number;
  readonly headSha: string;
};

/**
 * **流す並びを作る。**
 *
 * **依存の順そのもの**である（`DependencyOrder.ordered`）——**並べ替えない。**
 *
 * **commit が分からない PR は入れない**（#331）。**固定できないものを流さない**
 * ——**`MergeButton` が `headSha` 無しで押させないのと同じ判断**である。
 * **循環しているぶん（`cyclic`）も入らない**——**先に入れるものを名指しできない。**
 */
export function mergePlanSteps(
  order: DependencyOrder,
  headOf: (pullRequestNumber: number) => string | undefined,
): readonly MergePlanStepView[] {
  return order.ordered.flatMap((number) => {
    const headSha = headOf(number);
    return headSha === undefined ? [] : [{ number, headSha }];
  });
}

/**
 * 止まった理由。**成功を並べない**（#342 のレビュー）——**これは URL から渡ってくる値**
 * であり、**利用者が任意に作れる。** **「入りました」を語彙に入れた瞬間、
 * 流していない人がそれを出せる**（**取り消せない事実の主張**）。
 */
export type MergePlanNoticeKind =
  | "not-approved"
  | "not-mergeable"
  | "dependency-pending"
  | "base-changed"
  | "not-orderable"
  | "forbidden"
  | "nothing-to-run"
  | "unavailable";

/** 理由の文。**GitHub の文面を載せない**（§6）。 */
function reasonOf(kind: MergePlanNoticeKind): string {
  switch (kind) {
    case "not-approved":
      // **承認は commit に付く**（#635）——**そのあとに push されたものは誰も読んでいない**
      return "盤面が見せている commit が承認されていません";
    case "not-mergeable":
      return "いまはマージできません（コンフリクト・必須チェック・保護ルール）";
    case "dependency-pending":
      return "土台の PR が残っています";
    case "base-changed":
      return "判定したときと base が違います";
    case "not-orderable":
      return "順序を決められません";
    case "forbidden":
      return "このリポジトリへ書き込む権限がありません";
    case "nothing-to-run":
      return "流せる PR がありません";
    default:
      return "いま実行できません";
  }
}

/**
 * **どこまで進んだかを言う**（#661 の完了条件）。
 *
 * **止まった番号は言う**（**「入らなかった」の側**）。**入った本数は言わない**
 * ——**URL から出すと、流していない人が出せる。** **入ったぶんは盤面から消えている**
 * ので、**残っている行がそのまま「入っていないもの」**である。
 */
export function mergePlanNotice(kind: MergePlanNoticeKind, at: number | undefined): string {
  if (kind === "nothing-to-run" || kind === "forbidden" || at === undefined) {
    return `プランを流せませんでした: ${reasonOf(kind)}。`;
  }
  return `#${at} で止まりました: ${reasonOf(kind)}。#${at} とそれ以降は入っていません（入ったぶんは、この盤面から消えています）。`;
}

export type MergePlanButtonProps = {
  /** 送る先。**どこへ送るかを決めるのは、この部品の外**である。 */
  readonly action: string;
  /** 流す並び。**空なら押させない**——**流すものが無い。** */
  readonly steps: readonly MergePlanStepView[];
};

export function MergePlanButton({ action, steps }: MergePlanButtonProps) {
  return (
    <form action={action} method="post">
      {/* **見せた並びと commit を、そのまま送る**（#331）——**口の側でも
          判定し直す**ので、**ここは「何を見せていたか」を運ぶだけ**である */}
      {steps.map((step) => (
        <input
          key={step.number}
          name="step"
          type="hidden"
          value={`${step.number}:${step.headSha}`}
        />
      ))}
      <button className="underline" disabled={steps.length === 0} type="submit">
        マージ順に流す（{steps.length} 本）
      </button>
    </form>
  );
}
