/**
 * **その人の目で見えるリポジトリを、トークンごと解決する**（#682）。
 *
 * **`authorizeRepository` の手前半分**である——**開く / 期限を見る / 一覧を引く**まで。
 * **横断の盤面は「1 つを見てよいか」ではなく「見えるもの全部」**を要るので、
 * **ここで分けた**（**倒し分けを 2 箇所に持たない**。`AGENTS.md` §5）。
 *
 * **トークンを返すのは、次の口もユーザートークンで引くから**である（§6）
 * ——**installation トークンで代用しない。**
 */

import { errorKind } from "../observability/error-kind";
import type { UserTokenStore } from "../ports/user-token-store";
import type { VisibleRepositories, VisibleRepositoryListing } from "../ports/visible-repositories";
import type { UsableToken } from "./ensure-usable-token";

export type ResolvedVisibleRepositories =
  | { readonly kind: "signed-out" }
  | { readonly kind: "needs-login" }
  | { readonly kind: "unavailable"; readonly reason?: string }
  | {
      readonly kind: "resolved";
      readonly userAccessToken: string;
      readonly listing: VisibleRepositoryListing;
    };

export type ResolveVisibleRepositoriesInput = {
  /** **開く手続きごと受ける**（`authorizeRepository` と同じ形）。 */
  readonly openStore: () => Promise<UserTokenStore | undefined>;
  readonly ensure: (store: UserTokenStore) => Promise<UsableToken>;
  readonly repositories: VisibleRepositories;
};

export async function resolveVisibleRepositories({
  openStore,
  ensure,
  repositories,
}: ResolveVisibleRepositoriesInput): Promise<ResolvedVisibleRepositories> {
  let store: UserTokenStore | undefined;
  try {
    store = await openStore();
  } catch (error) {
    // **開けなかったことを「見えない」にも「期限切れ」にも化けさせない**
    return { kind: "unavailable", reason: `store/${errorKind(error)}` };
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
      return { kind: "unavailable", reason: "token" };
    case "usable":
      break;
  }

  try {
    return {
      kind: "resolved",
      userAccessToken: usable.accessToken,
      listing: await repositories.list(usable.accessToken),
    };
  } catch (error) {
    // **投げたものを `not-found` へ倒さない。** **故障が
    // 「そんなリポジトリはありません」に化ける**
    return { kind: "unavailable", reason: `list/${errorKind(error)}` };
  }
}
