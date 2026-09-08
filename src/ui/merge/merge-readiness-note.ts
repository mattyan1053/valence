/**
 * **押せない理由を、押す前に言う**（#629）。
 *
 * **#502 で利用者が Merge を押し、「いまマージできませんでした」だけが返った**
 * ——**原因（35 commits 遅れ / CONFLICTING）は画面のどこにも出ていなかった。**
 *
 * **判定はしない**（`RiskTierView` と同じ）。**`mergeReadinessOf` が返したものに、
 * 画面の語彙を当てるだけ**である。
 *
 * **依存の順序（`MergeButton` の `blockedBy`）とは別に出す。** **押せない理由が違う**
 * ——**混ぜると「なぜ押せないか」が言えなくなる**（#629）。
 *
 * **文言だけを持つ**（`changeUnavailableNote` と同じ形）——**器（`<span>`）は
 * 並べる側が持つ**ので、**「何も言わない」を `undefined` で表せる。**
 */

import type { MergeReadiness } from "../../domain/graph/merge-readiness";

/**
 * **`Record` で持つ。** **状況を足したときに書き忘れると型検査が落ちる**ので、
 * **名前も出ないまま画面に出る**ことが起きない（`TIER_TEXT` と同じ形）。
 *
 * **合流できるときは何も言わない。** **平常時に鳴るものは読まれなくなる**（#248）
 * ——**10 本並んだときに読むのは、普通でない行だけである。**
 *
 * **文面は「次に何をするか」まで書く。** **「押せない」だけでは、何をすればよいか
 * 分からない**（#345 が番号を返しているのと同じ理由）。
 */
const READINESS_TEXT: Record<MergeReadiness["kind"], string | undefined> = {
  mergeable: undefined,
  conflicting: "conflict しています（先に解消しないとマージできません）",
  behind: "base に遅れています（先に取り込み直さないとマージできません）",
  // **draft を言う行はほかに無い**（#644 のレビュー）——**CI とは違う**
  draft: "下書きのままです（ready for review にするまでマージできません）",
  // **どの規則で止まっているかは言わない**（#644 のレビュー 2 周目）——**`BLOCKED` は
  // 寄せ集め**なので、**名指しすると、成立していない理由を表示することになる**
  blocked: "保護ルールで止まっています（GitHub 側の条件を満たすまでマージできません）",
  // **「まだ分からない」を「マージできる」へ倒さない**（#540 / #541 と同じ向き）。
  // **GitHub が計算中の場合と、状況を読めなかった場合が入る**——**次の一手は同じ**
  unknown: "合流できるかは、まだ分かりません（読み込み直すと分かることがあります）",
};

/** その行に出す 1 文。**言うことが無ければ `undefined`。** */
export function mergeReadinessNote(readiness: MergeReadiness): string | undefined {
  return READINESS_TEXT[readiness.kind];
}
