/**
 * **1 クリックの Approve**（#315。MVP の 3 番目）。
 *
 * **この流れの本体は順序である。** **Approve は GitHub への書き込み**なので、
 * **実行するのは installation トークン**だが、**「押してよいか」はユーザートークンで
 * 決める**（`AGENTS.md` §6）——**installation トークンだけで実行すると、
 * ログインしていれば誰でも他人のリポジトリへ Approve を出せる。**
 *
 * **確かめてから実行する。** **順序が逆だと、確かめる前に GitHub が変わる**
 * ——**読むだけなら取り消せるが、書き込みは取り消せない。**
 *
 * **判断は共有している**（`authorizeRepository`）。**写すと、盤面側と片方だけ
 * 直したときに食い違う**——**症状は「他人のものを操作できる」**である。
 */

import { authorizeRepository } from "../auth/authorize-repository";
import type { UsableToken } from "../auth/ensure-usable-token";
import type { ReviewOutcome, ReviewRefusal } from "../ports/pull-request-review";
import type { UserTokenStore } from "../ports/user-token-store";
import type { VisibleRepositories, VisibleRepository } from "../ports/visible-repositories";

export type ApprovePullRequestResult =
  | { readonly kind: "signed-out" }
  | { readonly kind: "needs-login" }
  | { readonly kind: "unavailable" }
  /** **見えない。** **「権限がありません」と「ありません」を分けない**（§6）。 */
  | { readonly kind: "not-found" }
  | { readonly kind: "approved" }
  /** **押せたが、GitHub が断った。** **理由ごとにできることが違う。** */
  | { readonly kind: "refused"; readonly reason: ReviewRefusal };

export type ApprovePullRequestInput = {
  readonly repository: VisibleRepository;
  /** どの PR か。**要求ごとに決まる。** */
  readonly pullRequestNumber: number;
  readonly openStore: () => Promise<UserTokenStore | undefined>;
  readonly ensure: (store: UserTokenStore) => Promise<UsableToken>;
  /** **そのユーザーの目**。**押してよいかは、これだけで決める。** */
  readonly repositories: VisibleRepositories;
  /**
   * Approve を出す手続き。**installation トークンを使う側**である。
   *
   * **手続きごと受けるのは、「押してよい」と分かるまで 1 度も呼ばないため**——
   * **結果を受け取る形にすると、確かめる前に GitHub が変わる。**
   */
  readonly approve: () => Promise<ReviewOutcome>;
};

export async function approvePullRequest({
  repository,
  openStore,
  ensure,
  repositories,
  approve,
}: ApprovePullRequestInput): Promise<ApprovePullRequestResult> {
  const authorization = await authorizeRepository({ repository, openStore, ensure, repositories });
  if (authorization.kind !== "authorized") {
    return authorization;
  }

  try {
    return await approve();
  } catch {
    // **port は断りを値で返す約束**だが、**破る実装もありうる**——**そのまま抜けると、
    // 押した人にフレームワークのエラー画面が出て、用意した案内へ届かない**
    // （#316 で実際に踏んだ形）。**成功にはしない。**
    return { kind: "refused", reason: "unavailable" };
  }
}
