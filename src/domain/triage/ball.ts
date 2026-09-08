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

import type { MergeBlock } from "../graph/merge-block";
import type { MergeReadiness } from "../graph/merge-readiness";
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
 * 2. **承認済みで、合流でき、依存も残っていない** → **マージする人の番**
 * 3. **レビュー依頼が残っている** → **レビューする人の番**
 * 4. **依頼も無く、レビューも 1 件も無い** → **誰の番でもない（放置）**
 * 5. それ以外 → **分からない**
 *
 * **2 は「押せる」と同じ条件で言う**（#652 のレビュー）。**承認済みでも conflict
 * していれば入らない**し、**土台がまだ open なら押せない**——**積み重ねた PR は
 * このプロダクトの普通**である（§1）。**行が「いま入れられます」と言い、ボタンが
 * 無効になっていると、同じ画面が逆のことを言う。**
 *
 * **依存の判定はここに持たない。** **`mergeBlockFor` が返したものを受ける**
 * ——**あれはボタンと POST が通る 1 本**である（#345）。**写すと、片方が事実と違う日が来る。**
 *
 * **1 と 2 は、持ち主が読めなくても言える**（#652 のレビュー）——**どちらも
 * GitHub が言い切った事実**である。**アサインは 3 と 4 にしか要らない。**
 *
 * **既定の分岐に倒し先を置かない**（`READINESS_OF_STATE` と同じ理由）。
 * **読めなかった材料は `undefined` で来る**ので、**そこを `nobody` へ落とさない。**
 */
export function ballOf({
  opinion,
  readiness,
  block,
  assignment,
}: {
  /** レビューの意見。**読めていなければ `undefined`。** */
  readonly opinion: ReviewOpinion | undefined;
  /**
   * 合流できるか（`mergeReadinessOf` の種別）。
   *
   * **型で受ける**（#652 のレビュー）——**`string` にすると、`mergeable` を改名した
   * 日にここが型検査を素通りし**、**承認済みで合流できる PR が静かに落ちる**（#185）。
   */
  readonly readiness: MergeReadiness["kind"];
  /** 依存が残っていないか（`mergeBlockFor` の答え）。**読めていなければ `undefined`。** */
  readonly block: MergeBlock | undefined;
  /** 誰に振られているか。**読めていなければ `undefined`。** */
  readonly assignment: Assignment | undefined;
}): Ball {
  // **変更が求められていることは、持ち主が読めなくても言える**
  // ——**GitHub が言い切った事実**である
  if (opinion?.changesRequestedOnHead === true) {
    return "author";
  }
  // **承認と合流の状況も同じ性質である**（#652 のレビュー）——**アサインが読めなくても
  // 言える。** **「押せる」と同じ条件**なので、**依存が残っていれば言わない。**
  if (opinion?.approvesHead === true && readiness === "mergeable" && block?.kind === "ready") {
    return "merger";
  }
  if (opinion === undefined || assignment === undefined) {
    return "unknown";
  }
  // **依頼が残っているのは「まだ返していない人がいる」**ということである
  if (assignment.reviewers.length > 0) {
    return "reviewer";
  }
  // **レビューが 1 件でもあれば、放置ではない**（#636 の罠）——**ただし
  // 「誰の番か」までは決まらない**ので、**言わない側へ倒す。**
  return opinion.reviewed ? "unknown" : "nobody";
}
