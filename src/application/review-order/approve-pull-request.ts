/**
 * **PR に承認を出す**（#330。**#315 の 2/3**）。
 *
 * **この流れの本体は身元である。**
 *
 * **#317 が置いた認可をそのまま使う**——**認可を 2 通り持たない**（§5）。
 * **違うのは要求する高さだけ**で、**Approve は書き込みなので `require: "write"`**
 * である（**盤面は `read` のまま**——**`write` を要求すると read-only の人が
 * 盤面を見られなくなり、「レビュアー側の交通整理」そのものが壊れる**。§1）。
 *
 * **承認そのものも、押した人の身元で出す。** **installation トークンで出すと、
 * GitHub から見た承認者は App になる**——**「自分の PR は自分で承認できない」を
 * 迂回でき**、**その承認が保護ルールの必要承認数に数えられる。**
 * **本人には出せない効き目**なので、**代理ではなく権限の格上げ**である
 * （**人の判断で #317 から持ち越された条件**）。
 *
 * **自己承認をこちらで数え直さない。** **ユーザートークンで出せば GitHub が弾く**
 * ——**同じ規則を 2 箇所に置くと、向こうが変わったときに片方だけ古くなる**（§5）。
 *
 * **確かめる前に GitHub を変えない。** **承認の口は「押してよい」と分かるまで
 * 1 度も呼ばれない**（#314 / #317 と同じ形）。
 */

import { authorizeRepository } from "../auth/authorize-repository";
import type { UsableToken } from "../auth/ensure-usable-token";
import { errorKind } from "../observability/error-kind";
import type { PullRequestReviews } from "../ports/pull-request-review";
import type { RepositoryPermissions } from "../ports/repository-permissions";
import type { UserTokenStore } from "../ports/user-token-store";
import type { VisibleRepositories, VisibleRepository } from "../ports/visible-repositories";

export type ApprovePullRequestResult =
  /** ログインしていない。**誰の権限も無いので、何もしない**（§6）。 */
  | { readonly kind: "signed-out" }
  /** 失効していて、更新もできなかった。**入口へ戻す。** */
  | { readonly kind: "needs-login" }
  /** **入り直しても直らない**（置き場が落ちている / GitHub が返さない）。 */
  | { readonly kind: "unavailable"; readonly reason?: string }
  /**
   * **そのユーザーには無い。**
   *
   * **「見えない」と「存在しない」を分けない**（§6）。
   */
  | { readonly kind: "not-found" }
  /**
   * **見えるが、承認を出してよい権限が無い。**
   *
   * **`not-found` へ倒さない**（#317 のレビュー）——**見えていることは本人も
   * 知っている**ので、**隠すと「なぜ押せないか」が誰にも分からなくなる。**
   */
  | { readonly kind: "forbidden" }
  /**
   * **自分の PR は自分で承認できない**（GitHub が弾いた）。
   *
   * **`forbidden` と混ぜない。** **権限はあるのに押せない**という別の状態で、
   * **押した人が次に取る行動も違う**（**権限を貰う**のではなく**他の人に頼む**）。
   */
  | { readonly kind: "self-approval" }
  /** 承認した。 */
  | { readonly kind: "approved" };

export type ApprovePullRequestInput = {
  /** どのリポジトリか。**要求ごとに決まる**（設定に固定しない。§1）。 */
  readonly repository: VisibleRepository;
  /** どの PR か。 */
  readonly number: number;
  /**
   * **開く手続きごと受ける**（`viewRepositoryBoard` と同じ形）。
   * **開いた結果だけを受けると、開く手前で落ちたときにここへ入らない。**
   */
  readonly openStore: () => Promise<UserTokenStore | undefined>;
  readonly ensure: (store: UserTokenStore) => Promise<UsableToken>;
  /** **そのユーザーの目**。**見えるかどうかは、これだけで決める。** */
  readonly repositories: VisibleRepositories;
  /** **そのユーザーの権限の高さ**。**`write` を要求するので、ここでは引かれる。** */
  readonly permissions: RepositoryPermissions;
  /** 承認を出す口。**押した人の身元で出す側**である。 */
  readonly reviews: PullRequestReviews;
};

export async function approvePullRequest({
  repository,
  number,
  openStore,
  ensure,
  repositories,
  permissions,
  reviews,
}: ApprovePullRequestInput): Promise<ApprovePullRequestResult> {
  // **認可は共有の判断が持つ** (#315)。**ここへ写すと、盤面側と片方だけ直したときに
  // 食い違う**——**症状は「他人のリポジトリへ承認が出せる」**である。
  const authorization = await authorizeRepository({
    repository,
    openStore,
    ensure,
    repositories,
    permissions,
    // **書き込みなので `write`。** **`read` にすると、read-only の人が承認を出せる**
    require: "write",
  });
  if (authorization.kind !== "authorized") {
    return authorization;
  }

  try {
    // **確かめた本人のトークンで出す。** **`authorizeRepository` が
    // `userAccessToken` を返すのは、続けて使う側があるため**である（#317）。
    return await reviews.approve(authorization.userAccessToken, { repository, number });
  } catch (error) {
    // **投げたものを「押せた」に化けさせない。** **押していないのに
    // 「承認しました」と出ると、誰も気づけない**——**取り消す相手も無い。**
    // **どこで落ちたかを添える** (#506 の 2-b)
    return { kind: "unavailable", reason: `approve/${errorKind(error)}` };
  }
}
