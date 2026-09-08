/**
 * **その PR が、いま合流できるか**を GitHub の言い分から決める（#629）。
 *
 * **`mergeable` を見ていなかった。** **conflict しているかどうかは、Merge を押すまで
 * 分からなかった**——**#502 で利用者が押し、「いまマージできませんでした」だけが返った。**
 * **原因（35 commits 遅れ / CONFLICTING）は画面のどこにも出ていない。**
 *
 * **`MergeBlock` と混ぜない。** **あれは「依存の順序」**で、**こちらは「合流できるか」**
 * ——**押せない理由が違うので、混ぜると「なぜ押せないか」が言えなくなる**（#629）。
 * **同じ行に並べて、別々に言う。**
 *
 * **押させないための判定ではない。** **止めるのは依存の側だけ**で、**ここは
 * 押す前に理由を言う**（`AGENTS.md` §1 の「レビュアー側の交通整理」）。
 *
 * **純粋関数である**（§3）。**どこから取るかは、この層の関心ではない。**
 */

/** GitHub の `mergeable`。**読めなかったものも `unknown` に入る。** */
export type Mergeable = "mergeable" | "conflicting" | "unknown";

/**
 * GitHub の `mergeStateStatus`。
 *
 * **いまの判定が読むのは `behind` だけ**である。**それでも全部の値を運ぶ**
 * ——**境界が読んだものを、渡す手前で捨てない**（#628）。**捨てると、
 * 「何だったか」はこの型より外でしか言えなくなる。**
 *
 * **知らない値は `unknown` へ寄せる**（境界の仕事）——**増えた値を
 * 「マージできる」へ倒さない。**
 */
export type MergeState =
  | "behind"
  | "blocked"
  | "clean"
  | "dirty"
  | "draft"
  | "has-hooks"
  | "unknown"
  | "unstable";

/**
 * GitHub が言っている合流の状況。
 *
 * **2 つとも運ぶ。** **`mergeable` だけだと「conflict はしていないが、base に遅れて
 * いる」が言えない**——**#502 で押せなかったのは、まさにその形**である。
 */
export type MergeStatusReport = {
  readonly mergeable: Mergeable;
  readonly state: MergeState;
};

export type MergeReadiness =
  /** **合流できる。** **ここでは言うことが無い**（押せない理由は別の行が言う）。 */
  | { readonly kind: "mergeable" }
  /** **conflict している。** 先に解消しないと入らない。 */
  | { readonly kind: "conflicting" }
  /**
   * **base に遅れている。** 先に取り込み直さないと入らない。
   *
   * **「設定次第では入る」ではないか**を疑われた（#644 のレビュー。`AGENTS.md` §1 の
   * マルチテナント）。**確かめた**（2026-09-08、このリポジトリ）——**最新化を要求しない
   * 設定**（ruleset の `strict_required_status_checks_policy: false`）**で、
   * base に 1 commit 遅れている PR** は `BLOCKED` を返し、**`BEHIND` にはならなかった。**
   * **`BEHIND` が出るのは最新化を要求している側**なので、**そこでは断定してよい。**
   */
  | { readonly kind: "behind" }
  /**
   * **下書きのまま。** **GitHub が押させる前に止める。**
   *
   * **既定の「合流できる」へ落とさない**（#644 のレビュー）——**draft を言う行は
   * ほかに無い**ので、**落とすと押せるまま何も出ない**（**`blocked` / `unstable` とは違う**）。
   */
  | { readonly kind: "draft" }
  /**
   * **まだ分からない。**
   *
   * **2 つの場合が入る。** **GitHub が計算中**（`UNKNOWN`）と、
   * **状況そのものを読めていない**（一覧に出てこなかった）。
   * **どちらも「読み込み直す」が次の一手**なので、**言い分けない**
   * （`MergeBlock.not-orderable` と同じ判断）。
   */
  | { readonly kind: "unknown" };

/**
 * **その PR が合流できるか。**
 *
 * **`undefined` を「マージできる」へ倒さない**（#540 / #541 と同じ向き）。
 * **既定値を置かない**——**取れなかったぶんが「問題なし」に化ける。**
 *
 * **conflict を先に見る。** **GitHub が言い切った事実**なので、
 * **片方が計算中でも黙らせない。**
 *
 * **どちらかが分からなければ、分からないと言う。** **`mergeable` だけ読めても、
 * `state` が分からなければ「base に遅れている」を見落とす**——
 * **食い違っていても緩い側へ倒さない**（`mergeBlockFor` と同じ判断）。
 */
export function mergeReadinessOf(report: MergeStatusReport | undefined): MergeReadiness {
  if (report === undefined) {
    return { kind: "unknown" };
  }
  if (report.mergeable === "conflicting") {
    return { kind: "conflicting" };
  }
  if (report.mergeable === "unknown" || report.state === "unknown") {
    return { kind: "unknown" };
  }
  // **draft は GitHub が押させない**（#644 のレビュー）。**承認待ち（`blocked`）や
  // CI（`unstable`）と違い、これを言う行はほかに無い**ので、ここで言う
  if (report.state === "draft") {
    return { kind: "draft" };
  }
  return report.state === "behind" ? { kind: "behind" } : { kind: "mergeable" };
}
