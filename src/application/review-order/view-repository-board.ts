/**
 * **1 つのリポジトリの盤面を、画面へ渡せる形にする**（#314）。
 *
 * **この流れの本体は認可である。**
 *
 * **「誰が何を見てよいか」はユーザートークンが表す**（`AGENTS.md` §6）。
 * **PR のデータを取るのは installation トークン**でよいが、**あれは
 * 「リポジトリへの操作」**なので、**それだけで出すと、誰がログインしていても
 * 同じものが見える**——**確かめてから取りに行く。**
 *
 * **見られないリポジトリでは、存在も漏らさない。** **「権限がありません」と
 * 「ありません」を区別できる応答にしない**ので、**どちらも `not-found` である。**
 *
 * **倒し分けは `listVisibleRepositories` と揃える**（ログインしていない / 入り直す /
 * 故障）——**行き先が違うものを 1 つにまとめない**という理由がそのまま当たる。
 */

import type { UsableToken } from "../auth/ensure-usable-token";
import type { UserTokenStore } from "../ports/user-token-store";
import type {
  VisibleRepositories,
  VisibleRepository,
  VisibleRepositoryListing,
} from "../ports/visible-repositories";
import type { ReviewOrderPlan } from "./plan-review-order";

export type RepositoryBoardResult =
  /** ログインしていない。**誰の権限も無いので、データを出さない**（§6）。 */
  | { readonly kind: "signed-out" }
  /** 失効していて、更新もできなかった。**入口へ戻す。** */
  | { readonly kind: "needs-login" }
  /** **入り直しても直らない**（置き場が落ちている / 一覧を読めない）。 */
  | { readonly kind: "unavailable" }
  /**
   * **そのユーザーには無い。**
   *
   * **「見えない」と「存在しない」を分けない**（§6）——**分けた瞬間に、
   * 見えないほうの存在を教えることになる。**
   */
  | { readonly kind: "not-found" }
  | { readonly kind: "board"; readonly plan: ReviewOrderPlan };

export type ViewRepositoryBoardInput = {
  /** どのリポジトリを見るか。**要求ごとに決まる**（設定に固定しない。§1）。 */
  readonly repository: VisibleRepository;
  /**
   * **開く手続きごと受ける**（`listVisibleRepositories` と同じ形）。
   * **開いた結果だけを受けると、開く手前で落ちたときにここへ入らない。**
   */
  readonly openStore: () => Promise<UserTokenStore | undefined>;
  readonly ensure: (store: UserTokenStore) => Promise<UsableToken>;
  /** **そのユーザーの目**。**見てよいかは、これだけで決める。** */
  readonly repositories: VisibleRepositories;
  /**
   * 盤面を組み立てる手続き。**installation トークンを使う側**である。
   *
   * **手続きごと受けるのは、「見てよい」と分かるまで 1 度も呼ばないため**——
   * **結果を受け取る形にすると、確かめる前に取りに行くことになる。**
   */
  readonly plan: () => Promise<ReviewOrderPlan>;
};

/**
 * **見えるものの中に、その 1 件があるか。**
 *
 * **大文字小文字は区別しない。** **GitHub の owner / name は区別しない**ので、
 * **ここで区別すると、見られる人が「ありません」を受け取る。**
 */
function isVisible(listing: VisibleRepositoryListing, repository: VisibleRepository): boolean {
  return listing.repositories.some(
    (visible) =>
      visible.owner.toLowerCase() === repository.owner.toLowerCase() &&
      visible.name.toLowerCase() === repository.name.toLowerCase(),
  );
}

export async function viewRepositoryBoard({
  repository,
  openStore,
  ensure,
  repositories,
  plan,
}: ViewRepositoryBoardInput): Promise<RepositoryBoardResult> {
  let store: UserTokenStore | undefined;
  try {
    store = await openStore();
  } catch {
    // **開けなかったことを「見えない」にも「期限切れ」にも化けさせない**
    return { kind: "unavailable" };
  }
  if (store === undefined) {
    return { kind: "signed-out" };
  }

  const usable = await ensure(store);
  switch (usable.kind) {
    case "needs-login":
      // **使えないトークンで叩きに行かない。** **症状が「権限が無い」と混ざる**
      return { kind: "needs-login" };
    case "unavailable":
      // **`kind` を並べて書くのは、次に増えたときここで型が落ちるため**
      return { kind: "unavailable" };
    case "usable":
      return await boardFor(usable.accessToken);
  }

  async function boardFor(userAccessToken: string): Promise<RepositoryBoardResult> {
    let listing: VisibleRepositoryListing;
    try {
      listing = await repositories.list(userAccessToken);
    } catch {
      // **投げたものを `not-found` へ倒さない。** **故障が
      // 「そんなリポジトリはありません」に化ける**
      return { kind: "unavailable" };
    }

    if (isVisible(listing, repository)) {
      return { kind: "board", plan: await plan() };
    }
    // **判定不能を「無い」に倒さない**（§5）。**読めなかった行があるなら、
    // その中に居たかどうかを言えない**——**漏れはしない**（**`unavailable` は
    // 対象が在るかどうかに関係なく返る**ので、**存在を教えない**）
    if (listing.invalid.length > 0) {
      return { kind: "unavailable" };
    }
    return { kind: "not-found" };
  }
}
