/**
 * **PR をマージする口**（#331）。
 *
 * **押した本人の身元で出す**（`PullRequestReviews` と同じ。#330 で人が決めた条件）。
 * **installation トークンで実行すると、その人が持っていない効き目を与えることになる**
 * ——**保護ルールの「マージできる人」を迂回できる。**
 *
 * **マージできない理由を、こちらで数え直さない。** **コンフリクト・必須チェック・
 * 保護ルールの規則を写すと、写した側が古くなる**（`AGENTS.md` §5）——
 * **#330 で「自己承認は GitHub に判定させる」を選んだのと同じ判断**である。
 * **GitHub の応答を受けて分ける。**
 *
 * **検証済みのものだけを内側へ入れる**（§3）。
 */

import type { VisibleRepository } from "./visible-repositories";

/** どの PR をマージするか。**リポジトリは要求ごとに決まる**（§1）。 */
export type PullRequestMergeTarget = {
  readonly repository: VisibleRepository;
  readonly number: number;
};

/**
 * **GitHub が決めた答え。**
 *
 * **「出せなかった」を全部ここへ並べない。** **通信や設定の失敗は投げる**
 * ——**判定不能を結果の一種にすると、呼ぶ側が「答えが返った」と読む。**
 */
export type PullRequestMergeOutcome =
  /** マージした。 */
  | { readonly kind: "merged" }
  /**
   * **いまはマージできない**（GitHub が断った）。
   *
   * **理由を細かく分けない。** **コンフリクト・必須チェック未通過・保護ルールは
   * どれも「GitHub 側の状態が整っていない」**で、**押した人が次に取る行動は同じ**
   * ——**GitHub で PR を見に行く**である。
   * **分けようとすると、こちらが規則を写すことになる。**
   */
  | { readonly kind: "not-mergeable" };

export type PullRequestMerges = {
  /**
   * **その人の身元で**マージする。
   *
   * **受けるのはユーザートークンである。** **installation トークンを渡せる形に
   * しない**——**渡せるなら、いつか渡される。**
   *
   * **決められなかったら投げる。** **`not-mergeable` を「とりあえず」の答えに
   * しない**——**通信の失敗を「まだマージできません」と伝えると、
   * 押した人は待てば直ると思う。**
   */
  merge(userAccessToken: string, target: PullRequestMergeTarget): Promise<PullRequestMergeOutcome>;
};
