/**
 * **PR に承認を出す口**（#330）。
 *
 * **押した本人の身元で出す。** **installation トークンで出さない**
 * ——**人の判断で持ち越された条件**である（#317 → #330）。
 *
 * **理由は「代理」と「格上げ」の違いにある。** **App は `pull_requests: write` を
 * 持っている**ので、**installation トークンで承認を出すと、それは App の承認になる。**
 * **GitHub は「自分の PR は自分で承認できない」**が、**App は別の身元**なので、
 * **PR の作者本人が押しても有効な承認が付き**、**保護ルールの必要承認数にも数えられる**
 * ——**本人には出せない効き目**が、**この製品を通すと出せてしまう。**
 *
 * **ユーザートークンで出せば、その制限は GitHub 側でそのまま効く。**
 * **自己承認は GitHub が弾き**、**承認の重みもその人の権限のまま**である
 * ——**こちらで「作者かどうか」を数え直さない**（**同じ規則を 2 箇所に置くと、
 * GitHub 側が変わったときに片方だけ古くなる**。`AGENTS.md` §5）。
 *
 * **検証済みのものだけを内側へ入れる**（§3）。**応答の形を知るのは境界だけ**である。
 */

import type { VisibleRepository } from "./visible-repositories";

/** どの PR に出すか。**リポジトリは要求ごとに決まる**（設定に固定しない。§1）。 */
export type PullRequestReviewTarget = {
  readonly repository: VisibleRepository;
  readonly number: number;
};

/**
 * **GitHub が決めた答え。**
 *
 * **「出せなかった」を全部ここへ並べない。** **通信や設定の失敗は投げる**
 * （`VisibleRepositories` / `RepositoryPermissions` と同じ）——**判定不能を
 * 結果の一種にすると、呼ぶ側が「答えが返った」と読む。**
 *
 * **並べるのは、GitHub が確かに判断したもの**だけである。
 */
export type PullRequestReviewOutcome =
  /** 承認した。 */
  | { readonly kind: "approved" }
  /**
   * **自分の PR は自分で承認できなかった**（GitHub が弾いた）。
   *
   * **これを `unavailable` へ倒さない。** **押した人には「なぜ押せないか」が
   * 伝わらなければならない**（#330 の完了条件）——**故障として出すと、
   * 読み込み直せば直ると誤解される。**
   */
  | { readonly kind: "self-approval" };

export type PullRequestReviews = {
  /**
   * **その人の身元で**承認を出す。
   *
   * **受けるのはユーザートークンである。** **installation トークンを渡せる形に
   * しない**——**渡せるなら、いつか渡される。**
   *
   * **決められなかったら投げる。** **`self-approval` を「とりあえず」の答えに
   * しない**——**弾かれた理由が分からないまま「自己承認でした」と伝えると、
   * 押した人は自分の PR でないものを自分のものだと思う。**
   */
  approve(
    userAccessToken: string,
    target: PullRequestReviewTarget,
  ): Promise<PullRequestReviewOutcome>;
};
