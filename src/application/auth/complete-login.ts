/**
 * ログインを終える——**受け取った 1 組を、置き場へ入れられる形にする。**
 *
 * **ログインの応答には期限が入っていない。** 認証を通す側（Supabase）は
 * **GitHub のトークンをログインの瞬間だけ渡してきて、保持しない**——
 * **`expires_in` は渡ってこない。**
 *
 * **推測で埋めない。** **「8 時間だろう」と決め打つと、実際が短かった日に
 * 失効した token で GitHub を叩く**——**症状は 401 で、「権限が無い」と見分けが
 * 付かない**（**遅れて出る失敗**）。**受け取った refresh token で 1 度更新し、
 * GitHub が返した期限つきの 1 組を保存する。**
 *
 * **その 1 往復が、設定の裏取りも兼ねている** (#194)。**`expires_in` と
 * `refresh_token` が返らなければ、その応答は検証に落ちて例外になる**ので、
 * **「返るはず」を確かめないまま進むことがない。**
 */

import type { UserTokenStore } from "../ports/user-token-store";
import type { RefreshUserTokens } from "./ensure-usable-token";

/** ログインの応答が渡してくる 1 組。**期限は入っていない。** */
export type ProviderTokens = {
  readonly accessToken: string;
  readonly refreshToken: string;
};

/**
 * 入れられたか、入口へ戻すか。
 *
 * **`ensureUsableToken` と同じ形にする。** **呼ぶ側に要るのは
 * 「この人を入口へ戻すかどうか」だけ**で、理由の別は持たせない。
 */
export type LoginResult = { readonly kind: "signed-in" } | { readonly kind: "needs-login" };

export type CompleteLoginInput = {
  readonly store: UserTokenStore;
  readonly refresh: RefreshUserTokens;
  readonly provider: ProviderTokens;
};

export async function completeLogin({
  store,
  refresh,
  provider,
}: CompleteLoginInput): Promise<LoginResult> {
  let usable: Awaited<ReturnType<RefreshUserTokens>>;
  try {
    usable = await refresh(provider.refreshToken);
  } catch {
    // **期限の分からない 1 組を入れない。** **入れると、「いつまで使えるか」を
    // 誰も知らないまま使い続けることになる**——**入口へ戻すほうが安い。**
    return { kind: "needs-login" };
  }

  try {
    await store.save(usable);
  } catch {
    // **保存できていないのに「入れた」と言わない。** **次の要求で必ず失敗する**
    // ——**その場では動いて見え、次で壊れる。**
    return { kind: "needs-login" };
  }
  return { kind: "signed-in" };
}
