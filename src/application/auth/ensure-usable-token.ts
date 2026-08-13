/**
 * いま使えるユーザートークンを用意する。
 *
 * **ユーザートークンは 8 時間で失効する。** **失効を見なければ「ログインしているのに
 * 何も見えない」**という、**遅れて出る失敗**になる——**その場では気づけない。**
 *
 * **止まった状態から出られるところまでを 1 組にする** (#184)。
 *
 *   失効した            → 更新して復帰する
 *   更新にも失敗した     → **再ログインへ戻す**（「何も見えない画面」で終わらせない）
 *
 * **いまの時刻を引数で受ける。** **8 時間待たずに確かめられる**（#131 / #137）。
 */

import { isUsable } from "../../domain/auth/token-lifetime";
import type { UserTokenStore, UserTokens } from "../ports/user-token-store";

/**
 * 更新する口。**使い終わった refresh token を渡すと、新しい 1 組が返る。**
 *
 * **失敗したら投げる。** **古いものを返すと、呼ぶ側が「更新できた」と読む。**
 */
export type RefreshUserTokens = (refreshToken: string) => Promise<UserTokens>;

/**
 * 用意できたか、再ログインが要るか。
 *
 * **「使えない」を 1 つの形にまとめない。** 呼ぶ側が要るのは
 * **「この人を入口へ戻すかどうか」**だけなので、理由の別は持たせない——
 * **持たせると、呼ぶ側がそれぞれ分岐を書き、片方だけ古くなる。**
 */
export type UsableToken =
  | { readonly kind: "usable"; readonly accessToken: string }
  | { readonly kind: "needs-login" };

export type EnsureUsableTokenInput = {
  readonly store: UserTokenStore;
  readonly refresh: RefreshUserTokens;
  readonly now: Date;
};

/**
 * 保存されているものを読み直して、**使えるならそれを使う**。
 *
 * **読み直したものも `isUsable` に通す。** **通さずに返すと、失効したままの
 * access token で GitHub を叩く**——**症状は 401 になり、「権限が無い」と
 * 見分けられない。** **読めないことも「使える」へ倒さない。**
 */
async function usableFromStore(store: UserTokenStore, now: Date): Promise<UsableToken> {
  let current: UserTokens | undefined;
  try {
    current = await store.load();
  } catch {
    return { kind: "needs-login" };
  }
  if (isUsable(current, now)) {
    return { kind: "usable", accessToken: (current as UserTokens).accessToken };
  }
  return { kind: "needs-login" };
}

export async function ensureUsableToken({
  store,
  refresh,
  now,
}: EnsureUsableTokenInput): Promise<UsableToken> {
  const saved = await store.load();
  if (isUsable(saved, now)) {
    // `isUsable` が真なら `saved` は在る。**型の側でもそれを言う**
    return { kind: "usable", accessToken: (saved as UserTokens).accessToken };
  }
  if (saved === undefined) {
    // **渡す refresh token が無い。** **更新を試みない**——
    // **空の資格で叩くと、症状が「権限が無い」と混ざる。**
    return { kind: "needs-login" };
  }

  let renewed: UserTokens;
  try {
    renewed = await refresh(saved.refreshToken);
  } catch {
    // **負けただけかもしれない。** **失効の瞬間に、同じ人の要求が 2 本並ぶのは普通**
    // である（画面 1 枚でも、RSC もルートも別々に取りに行く）——**refresh token は
    // 1 度しか使えない**ので、**負けた側は必ず失敗する。** **その時点で、
    // 保存されているのは勝った側が書いた使える 1 組**である。
    //
    // **錠は採らない。** **本番はインスタンスが複数ある**ので、**プロセス内の錠は
    // 別インスタンスの要求に効かない**——**効かない錠は、効いていることを
    // 確かめられないぶん無いより悪い。**
    //
    // **繰り返さない。** **`refresh` を呼び直すと、同じ競合をもう一度開く。**
    return await usableFromStore(store, now);
  }

  // **保存できなければ「使える」とは言わない。** **GitHub 側で refresh token は
  // 1 度しか使えない**ので、**保存し損ねたまま進むと、次の要求で必ず失敗する**
  // ——**その場では動いて見え、次で壊れる。**
  try {
    await store.save(renewed);
  } catch {
    return { kind: "needs-login" };
  }
  return { kind: "usable", accessToken: renewed.accessToken };
}
