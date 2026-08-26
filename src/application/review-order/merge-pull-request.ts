/**
 * **PR をマージする**（#331。**#315 の 3/3**）。
 *
 * **2/3（`approvePullRequest`）と同じ土台を使う**——**認可を 2 通り持たない**（§5）。
 * **違うのは操作だけ**である。
 *
 * **マージも、押した人の身元で行う。** **installation トークンで実行すると、
 * その人が持っていない効き目を与えることになる**——**保護ルールの「マージできる人」を
 * 迂回できる**（**#330 で人が決めた条件と同じ形**）。
 *
 * **マージできない理由を、こちらで数え直さない。** **コンフリクト・必須チェック・
 * 保護ルールの規則を写すと、写した側が古くなる**——**GitHub の答えを受けて分ける。**
 *
 * **確かめる前に GitHub を変えない。** **マージの口は「押してよい」と分かるまで
 * 1 度も呼ばれない**（#314 / #317 / #330 と同じ形）。
 */

import { buildDependencyEdges } from "../../domain/graph/dependency-graph";
import { orderByDependency } from "../../domain/graph/dependency-order";
import { mergeBlockFor } from "../../domain/graph/merge-block";
import { authorizeRepository } from "../auth/authorize-repository";
import type { UsableToken } from "../auth/ensure-usable-token";
import { errorKind } from "../observability/error-kind";
import type { PullRequestMerges } from "../ports/pull-request-merge";
import type { PullRequestSource } from "../ports/pull-request-source";
import type { RepositoryPermissions } from "../ports/repository-permissions";
import type { UserTokenStore } from "../ports/user-token-store";
import type { VisibleRepositories, VisibleRepository } from "../ports/visible-repositories";

export type MergePullRequestResult =
  /** ログインしていない。**誰の権限も無いので、何もしない**（§6）。 */
  | { readonly kind: "signed-out" }
  /** 失効していて、更新もできなかった。**入口へ戻す。** */
  | { readonly kind: "needs-login" }
  /** **入り直しても直らない**（置き場が落ちている / GitHub が返さない）。 */
  | { readonly kind: "unavailable"; readonly reason?: string }
  /** **そのユーザーには無い**（§6。**「見えない」と「存在しない」を分けない**）。 */
  | { readonly kind: "not-found" }
  /**
   * **見えるが、マージしてよい権限が無い。**
   *
   * **`not-found` へ倒さない**——**見えていることは本人も知っている。**
   */
  | { readonly kind: "forbidden" }
  /**
   * **いまはマージできない**（GitHub が断った）。
   *
   * **`forbidden` と混ぜない。** **権限はあるのに通らない**という別の状態で、
   * **押した人が次に取る行動も違う**（**権限を貰う**のではなく**PR を整える**）。
   */
  | { readonly kind: "not-mergeable" }
  /**
   * **土台の PR が残っている**（#345）。
   *
   * **先に入れる番号を返す**——**「押せない」だけでは、何をすればよいか分からない。**
   * **GitHub は依存を知らない**ので、**これを止めるのはこちらの仕事**である。
   */
  | { readonly kind: "dependency-pending"; readonly blockedBy: readonly number[] }
  /**
   * **順序が決められないので、マージさせない**（#345）。
   *
   * **循環しているか、一覧に出てこない番号**である。
   * **`dependency-pending` と分ける**——**先に入れるものを名指しできない。**
   */
  | { readonly kind: "not-orderable" }
  /**
   * **判定したときと base が違う**（#350）。
   *
   * **`not-mergeable` とも `not-orderable` とも混ぜない**——**押した人が次に
   * することが違う**（**盤面を見直して、もう一度押す**）。
   */
  | { readonly kind: "base-changed" }
  /** マージした。 */
  | { readonly kind: "merged" };

export type MergePullRequestInput = {
  /** どのリポジトリか。**要求ごとに決まる**（§1）。 */
  readonly repository: VisibleRepository;
  /** どの PR か。 */
  readonly number: number;
  /**
   * **盤面で見せた head の commit**（#331 のレビュー）。
   *
   * **押した対象が、見せた対象であること**を GitHub 側で確かめさせる
   * ——**「押したあとに理由が伝わる」は、その前提の上にある。**
   */
  readonly headSha: string;
  /** **開く手続きごと受ける**（`approvePullRequest` と同じ形）。 */
  readonly openStore: () => Promise<UserTokenStore | undefined>;
  readonly ensure: (store: UserTokenStore) => Promise<UsableToken>;
  /** **そのユーザーの目**。**見えるかどうかは、これだけで決める。** */
  readonly repositories: VisibleRepositories;
  /** **そのユーザーの権限の高さ**。**`write` を要求するので、ここでは引かれる。** */
  readonly permissions: RepositoryPermissions;
  /** マージの口。**押した人の身元で行う側**である。 */
  readonly merges: PullRequestMerges;
  /**
   * **いまの PR 一覧**（#345）。
   *
   * **依存は押した時点で見る。** **盤面が描いた時点のものを信じない**——
   * **画面を経由しない要求が作れる**うえ、**盤面を出してから土台が動くこともある。**
   *
   * **手続きごと受ける**（他の口と同じ）——**「押してよい」と分かるまで呼ばない。**
   */
  readonly pullRequests: PullRequestSource;
};

export async function mergePullRequest({
  repository,
  number,
  headSha,
  openStore,
  ensure,
  repositories,
  permissions,
  merges,
  pullRequests,
}: MergePullRequestInput): Promise<MergePullRequestResult> {
  // **認可は共有の判断が持つ** (#315)。**ここへ写すと、盤面・Approve と
  // 片方だけ直したときに食い違う。**
  const authorization = await authorizeRepository({
    repository,
    openStore,
    ensure,
    repositories,
    permissions,
    // **書き込みなので `write`**（**Approve と同じ土台へ渡すだけ**）
    require: "write",
  });
  if (authorization.kind !== "authorized") {
    return authorization;
  }

  // **依存が残っていないかを、押した時点の一覧で見る**（#345）。
  // **表示の無効化だけでは足りない**——**画面を経由しない要求が作れる**（#342 と同じ形）。
  let block: ReturnType<typeof mergeBlockFor>;
  // **判定に使った base を控える**（#350）——**マージ直前に読み直して突き合わせる。**
  let judgedBaseBranch: string | undefined;
  try {
    const listing = await pullRequests.listPullRequests();
    judgedBaseBranch = listing.pullRequests.find((pullRequest) => pullRequest.number === number)
      ?.base.branch;
    const edges = buildDependencyEdges(listing.pullRequests);
    // **読めなかった PR の数も渡す**（#348 のレビュー）——**`invalid` に残ったものは
    // 辺を持たない**ので、**土台だけが読めなかった場合、上段が「依存なし」に見える。**
    // **その経路は投げないので、下の `catch` には入らない。**
    block = mergeBlockFor(
      number,
      edges,
      orderByDependency(listing.pullRequests, edges),
      listing.invalid.length,
    );
  } catch (error) {
    // **確かめられなければマージしない。** **依存を見られないまま通すと、
    // この Issue が塞ごうとしたものがそのまま通る**（#345）
    return { kind: "unavailable", reason: `order/${errorKind(error)}` };
  }
  if (judgedBaseBranch === undefined) {
    // **一覧に居ない番号**である。**`mergeBlockFor` も `not-orderable` へ倒す**が、
    // **突き合わせる base が無いまま進めない**——**先に断つ。**
    return { kind: "not-orderable" };
  }

  switch (block.kind) {
    case "depends-on":
      return { kind: "dependency-pending", blockedBy: block.numbers };
    case "not-orderable":
      return { kind: "not-orderable" };
    case "ready":
      break;
  }

  try {
    // **確かめた本人のトークンで行う**（#317 が `userAccessToken` を返す理由）
    return await merges.merge(authorization.userAccessToken, {
      repository,
      number,
      headSha,
      // **判定に使った base**（#350）——**adapter がマージ直前に突き合わせる。**
      expectedBaseBranch: judgedBaseBranch,
    });
  } catch (error) {
    // **投げたものを「マージできた」に化けさせない。** **マージは取り消せない**ので、
    // **「したかどうか分からない」を「した」と言うと、誰も確かめに行かない。**
    return { kind: "unavailable", reason: `merge/${errorKind(error)}` };
  }
}
