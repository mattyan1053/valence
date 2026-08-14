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
  /**
   * **置き場を開けなかった** (#213 のレビュー)。**期限切れと分ける**——
   * **入り直しても直らない故障**を、**認証切れとして隠さない。**
   */
  | { readonly kind: "unavailable" }
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
    // **開けなかったことを「見えない」にも「期限切れ」にも化けさせない。**
    // **入り直しても直らない**ので、**そう案内しない**
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
      // **開けたあとに落ちる経路も、開ける前と同じ行き先へ倒す** (#214)。
      // **`kind` を並べて書くのは、次に増えたときここで型が落ちるため**
      // ——**`if` 1 本だと、増えた `kind` が「使える」側へ流れる**
      // （**トークンを持たないまま `list` を呼ぶ**）
      return { kind: "unavailable" };
    case "usable":
      return { kind: "listed", listing: await repositories.list(usable.accessToken) };
  }
}
