/**
 * **そのユーザーが見られるリポジトリ**を、画面へ渡せる形にする。
 *
 * **3 つへ倒し分ける。** **ログインしていない / 入口へ戻す / 出す**——
 * **「出せない」を 1 つにまとめない**のは、**画面の行き先が違う**からである
 * （**ログインへ誘う**のか、**入り直してもらう**のか）。
 *
 * **静かに空を返さない** (#213 の完了条件)。**「開けなかった」を「1 件も見えない」に
 * 化けさせると、ログインしているのに何も見えない画面が正常に見える。**
 */

import type { UsableToken } from "../auth/ensure-usable-token";
import type { UserTokenStore } from "../ports/user-token-store";
import type { VisibleRepositories, VisibleRepositoryListing } from "../ports/visible-repositories";

export type VisibleRepositoriesResult =
  /** ログインしていない。**誰の権限も無いので、データを出さない**（§6）。 */
  | { readonly kind: "signed-out" }
  /** 失効していて、更新もできなかった。**入口へ戻す。** */
  | { readonly kind: "needs-login" }
  | { readonly kind: "listed"; readonly listing: VisibleRepositoryListing };

export type ListVisibleRepositoriesInput = {
  /**
   * **開く手続きごと受ける**（`completeLogin` と同じ形）。
   * **開いた結果だけを受けると、開く手前で落ちたときにここへ入らない。**
   */
  readonly openStore: () => Promise<UserTokenStore | undefined>;
  readonly ensure: (store: UserTokenStore) => Promise<UsableToken>;
  readonly repositories: VisibleRepositories;
};

export async function listVisibleRepositories({
  openStore,
  ensure,
  repositories,
}: ListVisibleRepositoriesInput): Promise<VisibleRepositoriesResult> {
  let store: UserTokenStore | undefined;
  try {
    store = await openStore();
  } catch {
    // **開けなかったことを「見えない」に化けさせない。** **入口へ戻す**
    return { kind: "needs-login" };
  }
  if (store === undefined) {
    return { kind: "signed-out" };
  }

  const usable = await ensure(store);
  if (usable.kind === "needs-login") {
    // **使えないトークンで叩きに行かない。** **症状が「権限が無い」と混ざる**
    return { kind: "needs-login" };
  }

  return { kind: "listed", listing: await repositories.list(usable.accessToken) };
}
