/**
 * PR に Approve を出す口（#315）。
 *
 * **これは「リポジトリへの操作」**なので、**実装側は installation トークンで叩く**
 * （`AGENTS.md` §6）。**「押してよいか」はこの口の外**で、**ユーザートークンで
 * 決まっている**——**この口は、決まったあとに呼ばれる。**
 *
 * **失敗を握りつぶさない。** **落ちた理由が押した人に見えること**が完了条件なので、
 * **「できなかった」を成功と同じ形で返さない。**
 *
 * **応答の中身をそのまま返さない**（§6）。**他人の持ち物が混ざりうる**ので、
 * **境界で「どの種類の断りか」へ畳んでから内側へ入れる**——**画面に出るのは、
 * この分類から作った文だけ**である。
 */

/**
 * 断られた理由。**行き先が違うものを 1 つにまとめない**
 * （`UsableToken` と同じ判断）——**押した人にできることが変わる。**
 */
export type ReviewRefusal =
  /** **App にその権限が無い**（403）。**押した人には解けない。** */
  | "not-permitted"
  /** **GitHub が受け付けない**（422。自分の PR を Approve した等）。 */
  | "not-reviewable"
  /** **その PR が無い**（404。閉じた / 消えた / 番号違い）。 */
  | "gone"
  /** **いまは分からない**（5xx・通信・応答が読めない）。**もう一度なら通りうる。** */
  | "unavailable";

/** Approve を出した結果。**例外で表さない**——**断りは想定内である。** */
export type ReviewOutcome =
  | { readonly kind: "approved" }
  | { readonly kind: "refused"; readonly reason: ReviewRefusal };

export type PullRequestReview = {
  /**
   * その PR に Approve を出す。
   *
   * **番号は要求ごとに決まる**（設定に固定しない。§1）。**どのリポジトリかは
   * 実装が握っている**——**合成ルートが要求ごとに束ねる。**
   */
  approve(pullRequestNumber: number): Promise<ReviewOutcome>;
};
