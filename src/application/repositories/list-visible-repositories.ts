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
import type { ResolvedVisibleRepositories } from "../auth/resolve-visible-repositories";
import { resolveVisibleRepositories } from "../auth/resolve-visible-repositories";
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

/**
 * **解決した結果を、画面の語彙へ落とす**（#686 のレビュー）。
 *
 * **解決そのものは `resolveVisibleRepositories` が持つ**——**`/` は 2 つのものを
 * 出すが、見えるリポジトリを引くのは 1 度だけ**である（**2 度引くと、
 * 100 件を超えるアカウントでは全ページが二重になる**）。
 *
 * **倒し分けはここ 1 箇所**である。
 */
export function toVisibleRepositoriesResult(
  resolved: ResolvedVisibleRepositories,
): VisibleRepositoriesResult {
  switch (resolved.kind) {
    case "signed-out":
      return { kind: "signed-out" };
    case "needs-login":
      return { kind: "needs-login" };
    case "unavailable":
      // **開けなかった / 期限切れ / 引けなかった**——**どれも入り直しても直らない**
      // ので、**そう案内しない**（**落ちどころは記録の側に残る**）
      return { kind: "unavailable" };
    case "resolved":
      return { kind: "listed", listing: resolved.listing };
  }
}

export async function listVisibleRepositories(
  input: ListVisibleRepositoriesInput,
): Promise<VisibleRepositoriesResult> {
  return toVisibleRepositoriesResult(await resolveVisibleRepositories(input));
}
