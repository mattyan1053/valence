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
  /**
   * 本人として置き場を開く。**その人がいなければ `undefined`。**
   *
   * **開く手続きごと受け取る** (#224 のレビュー)。**開いた結果だけを受け取ると、
   * 開く手前で落ちたときにここへ一度も入らない**——**「作りかけのセッションを
   * 畳む」が、その経路にだけ効かなくなる。**
   *
   * **「いない人」と「開けなかった」を分ける。** **前者は入口へ戻せば済む**が、
   * **後者は設定が直るまで直らない**——**混ぜると、原因がどこにも出ない。**
   */
  readonly openStore: () => Promise<UserTokenStore | undefined>;
  readonly refresh: RefreshUserTokens;
  readonly provider: ProviderTokens;
  /**
   * 作りかけのセッションを畳む口。
   *
   * **交換が済んだ時点で、認証の Cookie は置かれている**——**そこから先で落ちて
   * 「入口へ戻す」とだけ返すと、画面は入口なのに認証だけ済んだ状態が残る**
   * （#224 のレビュー）。**上に書いた不変条件が、そこで破れる。**
   */
  readonly abandonSession: () => Promise<void>;
};

/**
 * 入れられなかった。**セッションも畳んでから戻す。**
 *
 * **畳めなかったら投げる。** **「入口へ戻した」とだけ返すと、
 * ログイン済みのまま残ったことが消える**（`signOut` と同じ判断）。
 */
async function abandon(abandonSession: () => Promise<void>): Promise<LoginResult> {
  await abandonSession();
  return { kind: "needs-login" };
}

export async function completeLogin({
  openStore,
  refresh,
  provider,
  abandonSession,
}: CompleteLoginInput): Promise<LoginResult> {
  let store: UserTokenStore | undefined;
  try {
    store = await openStore();
  } catch (error) {
    // **畳んでから投げ直す。** **握りつぶすと、設定の不備が「入口へ戻った」に
    // 化ける**——**毎回同じところで失敗しているのに、誰にも見えない。**
    await abandonSession();
    throw error;
  }

  if (store === undefined) {
    // **交換は通ったのに、その人がいない。** **こちらは入口へ戻せば済む。**
    return abandon(abandonSession);
  }

  let usable: Awaited<ReturnType<RefreshUserTokens>>;
  try {
    usable = await refresh(provider.refreshToken);
  } catch {
    // **期限の分からない 1 組を入れない。** **入れると、「いつまで使えるか」を
    // 誰も知らないまま使い続けることになる**——**入口へ戻すほうが安い。**
    return abandon(abandonSession);
  }

  try {
    await store.save(usable);
  } catch {
    // **保存できていないのに「入れた」と言わない。** **次の要求で必ず失敗する**
    // ——**その場では動いて見え、次で壊れる。**
    return abandon(abandonSession);
  }
  return { kind: "signed-in" };
}
