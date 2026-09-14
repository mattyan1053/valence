/**
 * **表の 1 マスに出す文**（#716）。
 *
 * **判定はしない**（`ballNote` / `mergeReadinessNote` と同じ）——**材料を画面の語彙に
 * 当てるだけ**である。
 *
 * **行の散文とは別の語彙にする。** **`RiskTierView` の `CI_TEXT` は
 * 「CI: まだ終わっていません（待てば済みます）」**——**次の行動まで言う文**で、
 * **列に入れると横に潰れる**（#714 の注意）。**言っている事実は同じ `CiStatus`** で、
 * **判定は domain が 1 箇所で持っている**ので、**食い違いようが無い**
 * ——**`Record<CiStatus, …>` なので、値が増えた日はどちらも型検査が落ちる。**
 *
 * **「読めなかった」を空欄にしない**（`AGENTS.md` §5）——**空欄は「無い」と
 * 見分けが付かない。**
 */

import type { CiStatus } from "../../domain/triage/risk-tier";

/** **材料が引けなかったマス。** **どの列でも同じ言い方にする。** */
const UNREADABLE = "読めません";

const CI_CELL_TEXT: Record<CiStatus, string> = {
  passing: "通った",
  pending: "実行中",
  failing: "落ちた",
};

export function ciCellNote(status: CiStatus | undefined): string {
  return status === undefined ? UNREADABLE : CI_CELL_TEXT[status];
}

/** **PR の大きさ。** **2 つの数を 1 マスに置く**——**列を増やすより横に効く。** */
export function sizeCellNote(
  size: { readonly files: number; readonly lines: number } | undefined,
): string {
  return size === undefined ? UNREADABLE : `${size.files} ファイル / ${size.lines} 行`;
}

/**
 * **最後に動いてから何日か。**
 *
 * **「今日」と言い切る**（**0 日前とは書かない**）——**数えているのは
 * `activeDaysSince`** で、**ここは言い方だけ**である。
 */
export function activeDaysCellNote(days: number | undefined): string {
  if (days === undefined) {
    return UNREADABLE;
  }
  return days === 0 ? "今日" : `${days} 日前`;
}

/**
 * **その PR が何本の上に積まれているか。**
 *
 * **読めない場合が無い**——**辺は盤面が持っている**（**読めなかった PR は
 * 一覧に居ない**）。**0 本も出す**——**空欄にすると、比べられない。**
 */
export function dependsOnCellNote(count: number): string {
  return String(count);
}
