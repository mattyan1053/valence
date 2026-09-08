/**
 * **ボールが誰にあるか**を決める（#636）。
 *
 * **盤面を見て最初に知りたいのは「自分が動く番か」**である。**いまはどこにも
 * 出ていなかった。**
 *
 * **既にある行とは別の軸である。**
 *
 * | 行 | 言うこと |
 * | --- | --- |
 * | `RiskTierView` | どれだけ危ないか |
 * | `mergeReadinessNote` | 入るかどうか |
 * | `assignmentNote`（#631） | **誰の持ち物か（人）** |
 * | ここ | **誰の番か（役割）** |
 *
 * **#631 と混ぜない。** **「振られている」と「番である」は別**——**誰にも振られて
 * いない PR でも、変更が求められていれば著者の番**である。
 *
 * **純粋関数である**（§3）。**材料をどこから取るかは、この層の関心ではない。**
 */

import type { Assignment } from "./assignment";

/**
 * その PR に出ているレビューの意見。
 *
 * **`approvesHead` / `changesRequestedOnHead` は、いまの head に付いた意見だけ**である
 * ——**#635 で承認を commit に固定したのと同じ理由**で、**そのあとに push された
 * ものは、誰も読んでいない差分**である。
 *
 * **`reviewed` は意見を持たないレビューも数える**（#636 の罠）。**`requested_reviewers`
 * は「まだ返していない依頼」だけ**なので、**提出した人は一覧から消える**
 * ——**依頼の有無だけで「放置」と書くと、いちばん動いている PR が放置に見える。**
 *
 * **実測（2026-09-08、この PR）**: **`reviews.totalCount` が 6 なのに、
 * `latestOpinionatedReviews` は 0 件**だった（**自動レビューは意見を持たない
 * `COMMENTED`**）。**「レビューされたか」を意見の数で測ると、そこを落とす。**
 */
export type ReviewOpinion = {
  /** いまの head を承認している意見があるか。 */
  readonly approvesHead: boolean;
  /** いまの head に対して変更を求めている意見があるか。 */
  readonly changesRequestedOnHead: boolean;
  /** レビューが 1 件でも提出されているか。**意見を持たないものも数える。** */
  readonly reviewed: boolean;
};

/**
 * 誰の番か。
 *
 * **`unknown` を持つ**（`AssignmentState` と同じ形）——**読めなかったもの**と、
 * **読めたが規則のどれにも当たらないもの**が入る。**どちらも「言わない」側**であり、
 * **`nobody`（放置）へ倒さない**のがこの型の要点である。
 */
export type Ball = "author" | "merger" | "reviewer" | "nobody" | "unknown";

/**
 * **ボールが誰にあるか。**
 *
 * **順序が効く。** **上にあるものほど、GitHub が言い切った事実に近い。**
 *
 * 1. **変更が求められている**（head に付いた意見）→ **著者の番**
 * 2. **承認済みで、合流できる** → **マージする人の番**
 * 3. **レビュー依頼が残っている** → **レビューする人の番**
 * 4. **依頼も無く、レビューも 1 件も無い** → **誰の番でもない（放置）**
 * 5. それ以外 → **分からない**
 *
 * **2 は合流できるときだけ**である。**承認済みでも conflict していれば押しても
 * 入らない**——**その理由は別の行が言う**（#629）。
 *
 * **既定の分岐に倒し先を置かない**（`READINESS_OF_STATE` と同じ理由）。
 * **読めなかった材料は `undefined` で来る**ので、**そこを `nobody` へ落とさない。**
 */
export function ballOf({
  opinion,
  readiness,
  assignment,
}: {
  /** レビューの意見。**読めていなければ `undefined`。** */
  readonly opinion: ReviewOpinion | undefined;
  /** 合流できるか（`mergeReadinessOf` の種別）。 */
  readonly readiness: string;
  /** 誰に振られているか。**読めていなければ `undefined`。** */
  readonly assignment: Assignment | undefined;
}): Ball {
  // **変更が求められていることは、持ち主が読めなくても言える**
  // ——**GitHub が言い切った事実**である
  if (opinion?.changesRequestedOnHead === true) {
    return "author";
  }
  if (opinion === undefined || assignment === undefined) {
    return "unknown";
  }
  if (opinion.approvesHead && readiness === "mergeable") {
    return "merger";
  }
  // **依頼が残っているのは「まだ返していない人がいる」**ということである
  if (assignment.reviewers.length > 0) {
    return "reviewer";
  }
  // **レビューが 1 件でもあれば、放置ではない**（#636 の罠）——**ただし
  // 「誰の番か」までは決まらない**ので、**言わない側へ倒す。**
  return opinion.reviewed ? "unknown" : "nobody";
}
