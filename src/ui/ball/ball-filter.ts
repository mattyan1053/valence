/**
 * **誰の番かで絞る口**（#663 / #667）。**画面の語彙だけを持つ。**
 *
 * **判定はしない**（`ballNote` と同じ）——**通すかどうかは `filterByBall` が決める。**
 *
 * **受ける値と、出す選択肢を 1 つの並びから作る。** **離すと、画面に無い絞りを
 * URL で選べる**（**その逆も起きる**）——**`?ball=` は誰でも好きな文字列を
 * 入れられる**ので、**並べたものだけを通す**（`approveNoticeKind` と同じ判断。#330）。
 *
 * **運ぶ側（#667）と絞る側（#663）が、ここで揃った。** **知らない値は
 * 「絞らない」へ落ちる**ので、**どちらが先に入っても壊れなかった。**
 */

import type { Ball } from "../../domain/triage/ball";

/**
 * **画面が出す絞り込み。**
 *
 * **`unknown` は出さない。** **読めなかったものと、規則のどれにも当たらないものが
 * 入る**（`ballOf`）——**`ballNote` が何も言わない側**であり、
 * **選んでも「何の集まりか」が言えない。**
 *
 * **`Ball` の一部であることを型で縛る**（`satisfies`）——**縛らないと、
 * 打ち間違えた選択肢が「どの行にも当たらない絞り」として静かに出る**（#185 の形）。
 */
export const BALL_FILTERS = [
  "author",
  "reviewer",
  "merger",
  "nobody",
] as const satisfies readonly Ball[];

/** 出す選択肢の 1 つ。**`Ball` の一部である。** */
export type BallFilter = (typeof BALL_FILTERS)[number];

/**
 * **横断の盤面が出す絞り込み**（#694 のレビュー 2 周目）。
 *
 * **「マージする人の番」を出さない。** **`ballOf` が `merger` を返すのは
 * `block?.kind === "ready"` のときだけ**だが、**横断は依存を跨がないので
 * `block` を渡せない**（`cross-repository-board.tsx` の但し書き）——**構造的に
 * 出ない選択肢**である。
 *
 * **出しても必ず 0 件になる**ので、**押した人は「無い」と読む**——**実際は
 * 「この画面では判定していない」**であって、**同じことではない。**
 *
 * **`BALL_FILTERS` から作る**——**並べ直さない**（**片方だけ増えると、
 * 画面によって語彙が変わる**）。
 */
export const CROSS_BALL_FILTERS: readonly BallFilter[] = BALL_FILTERS.filter(
  (ball) => ball !== "merger",
);

/**
 * **短い名前。** **`Record` で持つ**ので、**選択肢を足して書き忘れると型検査が落ちる**
 * （`BALL_TEXT` と同じ形）。
 *
 * **行の文（`ballNote`）とは別**である——**あちらは 1 件の説明**、**こちらは束の名前。**
 */
const FILTER_LABEL: Record<BallFilter, string> = {
  author: "著者の番",
  reviewer: "レビューする人の番",
  merger: "マージする人の番",
  nobody: "誰の番でもない",
};

export function ballFilterLabel(ball: BallFilter): string {
  return FILTER_LABEL[ball];
}

/**
 * **いま絞っていることを言う 1 文。** **絞っていなければ `undefined`。**
 *
 * **隠した件数を必ず出す**（#663）——**絞られていることに気づけないと、
 * 見えていないものに気づけない。** **隠した件数が 0 でも言う**
 * ——**「全部が当てはまった」と「絞っていない」は違う。**
 *
 * **通ったものが 0 件なら、そう言う**（#410 が `EmptyNotice` で塞いだ形）
 * ——**一覧が空のまま隠した件数だけ言っても、当てはまるものが無いのか、
 * 読み落としたのかが分からない。**
 *
 * **ただし、読めていない範囲が残るなら言い切らない**（#694 のレビュー）
 * ——**#686 のレビューが盤面の空表示で塞いだのと同じ形**である。
 * **「読めませんでした」と言った直後に「ありません」と言うと、同じ画面が逆のことを言う**
 * ——**読めなかった PR が、その番のものだったかもしれない。**
 *
 * **`undecided` に既定を置かない**（#669 のレビューと同じ判断）——**置くと、
 * 渡し忘れても動く**ので、**読めない範囲を持つ画面が増えたときに片方だけが直る。**
 */
export function ballFilterNote(
  ball: BallFilter | undefined,
  counts: {
    readonly shown: number;
    readonly hidden: number;
    /**
     * **この絞りで判定できなかった PR の数。**
     *
     * **2 つが入る**（#694 のレビュー 2 周目で広げた）——**盤面に出ていないもの**
     * （**読めなかった・読み切れなかった**）と、**出ているが「分からない」に
     * 倒れたもの**（`ballOf` の `unknown`。**材料を読めなかった行**）。
     *
     * **どちらも「その番のものだったかもしれない」**側である——**数えないと、
     * 画面が「ありません」と言い切る。**
     */
    readonly undecided: number;
  },
): string | undefined {
  if (ball === undefined) {
    return undefined;
  }
  const label = ballFilterLabel(ball);
  const hidden = `${counts.hidden} 件を隠しています`;
  if (counts.shown > 0) {
    return `「${label}」だけを出しています（${hidden}）`;
  }
  // **限定が要るのは「無い」と言うときだけ**——**平常時に断りを足すと読まれなくなる**（#248）
  return counts.undecided === 0
    ? `「${label}」の PR はありません（${hidden}）`
    : `読めた範囲に「${label}」の PR はありません（${hidden}）`;
}
