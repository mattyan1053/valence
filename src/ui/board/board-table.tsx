/**
 * **盤面の表の器**（#716 / #717）。
 *
 * **列の名前と、マスの見た目を、ここ 1 箇所が決める**（`AGENTS.md` §5）
 * ——**表が 2 つになったので、書き写すと片方だけ直して食い違う**（#713 と同じ形）。
 *
 * **出す列は、表ごとに選ぶ。** **同じ列を使えるはず、を確かめた結果、
 * 全部は共有できなかった**——**依存 PR 数は「守らないとマージが壊れる制約」**で、
 * **推奨レビュー順は「時間の使い方の目安」**である（#717 の注意）。
 * **混ぜると、土台より先に積み荷をマージしようとする**（`review-board.tsx` の判断）。
 *
 * **判定はしない。** **受け取ったものを、決まった形で並べるだけ**である。
 */

import type { ReactNode } from "react";

/** **表に出せる列。** **名前と桁の揃え方は、この地図が持つ。** */
export type BoardColumn = "pull-request" | "ci" | "size" | "active" | "depends-on" | "actions";

type ColumnRule = {
  readonly header: string;
  /** **数字の列は桁を揃える**（#714 の注意）——**揃わないと、比べるために読むことになる。** */
  readonly numeric: boolean;
};

/**
 * **`Record` で持つ**（`TIER_TEXT` と同じ形）——**列が増えた日に書き忘れると
 * 型検査が落ちる**ので、**名前も出ないまま画面に出ることが起きない。**
 */
const COLUMNS: Record<BoardColumn, ColumnRule> = {
  "pull-request": { header: "PR", numeric: false },
  ci: { header: "CI", numeric: false },
  size: { header: "サイズ", numeric: true },
  active: { header: "最後に動いた", numeric: true },
  "depends-on": { header: "依存 PR 数", numeric: true },
  actions: { header: "操作", numeric: false },
};

/** **1 マスの器。** **線と余白を 1 箇所で決める**——**列ごとに書くと揃わない。** */
export const BOARD_CELL = "border-[var(--node-stroke)] border-t px-3 py-2 align-top";

/** その列のマスに当てる class。 */
export function boardCellClass(column: BoardColumn): string {
  const rule = COLUMNS[column];
  return rule.numeric ? `${BOARD_CELL} whitespace-nowrap tabular-nums` : BOARD_CELL;
}

export function BoardTable({
  caption,
  columns,
  children,
}: {
  /**
   * **並びの理由を、表そのものが持つ**——**`<table>` は `<ol>` と違って
   * 「順がある」と言わない**（#705 のレビューと同じ関心）。
   */
  readonly caption: string;
  readonly columns: readonly BoardColumn[];
  readonly children: ReactNode;
}) {
  return (
    // **狭い画面で列が潰れないようにする**（#714 の注意）——**器が横に流れる**ので、
    // **画面ごと横に伸びることはない**（#583 で踏んだ形の再演を避ける）。
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <caption className="pb-2 text-left text-sm text-[var(--muted)]">{caption}</caption>
        <thead>
          <tr className="text-sm text-[var(--muted)]">
            {columns.map((column) => (
              <th className="px-3 py-1 font-normal" key={column} scope="col">
                {COLUMNS[column].header}
              </th>
            ))}
          </tr>
        </thead>
        {/* **`<tbody>` は 1 件（または 1 束）ぶん**——**ここでは包まない** */}
        {children}
      </table>
    </div>
  );
}
