/**
 * **そのリポジトリを、そのユーザーが触ってよいか**を決める（#315）。
 *
 * **「誰が何を見てよいか」はユーザートークンが表す**（`AGENTS.md` §6）。
 * **installation トークンは「リポジトリへの操作」**なので、**それだけで判断すると、
 * 誰がログインしていても同じことができる**——**読むだけなら「他人の盤面が見える」で
 * 済むが、書き込みでは「他人のリポジトリを merge できる」になる。**
 *
 * **判断はここ 1 箇所に置く。** **#314 が盤面の前に確かめている手順と同じもの**を、
 * **Approve / Merge でも通す**——**写すと、片方だけ直したときに食い違う**（§5）。
 *
 * **確かめてから実行する側へ渡す。** **この関数は「確かめる」だけで、
 * 操作そのものは持たない**——**呼ぶ側が `authorized` を受けてから動く。**
 */

import type { UserTokenStore } from "../ports/user-token-store";
import type {
  VisibleRepositories,
  VisibleRepository,
  VisibleRepositoryListing,
} from "../ports/visible-repositories";
import type { UsableToken } from "./ensure-usable-token";

export type RepositoryAuthorization =
  /** ログインしていない。**誰の権限も無いので、何もしない**（§6）。 */
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
  /** 触ってよい。**誰の目で確かめたか**も返す（続けて使う側があるため）。 */
  | { readonly kind: "authorized"; readonly userAccessToken: string };

export type AuthorizeRepositoryInput = {
  /** どのリポジトリか。**要求ごとに決まる**（設定に固定しない。§1）。 */
  readonly repository: VisibleRepository;
  /**
   * **開く手続きごと受ける。** **開いた結果だけを受けると、開く手前で落ちたときに
   * ここへ入らない**——**その経路だけ倒し分けが効かなくなる。**
   */
  readonly openStore: () => Promise<UserTokenStore | undefined>;
  readonly ensure: (store: UserTokenStore) => Promise<UsableToken>;
  /** **そのユーザーの目**。**触ってよいかは、これだけで決める。** */
  readonly repositories: VisibleRepositories;
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

export async function authorizeRepository({
  repository,
  openStore,
  ensure,
  repositories,
}: AuthorizeRepositoryInput): Promise<RepositoryAuthorization> {
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
      break;
  }

  let listing: VisibleRepositoryListing;
  try {
    listing = await repositories.list(usable.accessToken);
  } catch {
    // **投げたものを `not-found` へ倒さない。** **故障が
    // 「そんなリポジトリはありません」に化ける**
    return { kind: "unavailable" };
  }

  if (isVisible(listing, repository)) {
    return { kind: "authorized", userAccessToken: usable.accessToken };
  }
  // **判定不能を「無い」に倒さない**（§5）。**読めなかった行があるなら、
  // その中に居たかどうかを言えない**——**漏れはしない**（**`unavailable` は
  // 対象が在るかどうかに関係なく返る**ので、**存在を教えない**）
  if (listing.invalid.length > 0) {
    return { kind: "unavailable" };
  }
  return { kind: "not-found" };
}
