/**
 * いま使えるユーザートークンを用意する。
 *
 * **ユーザートークンは 8 時間で失効する。** **失効を見なければ「ログインしているのに
 * 何も見えない」**という、**遅れて出る失敗**になる——**その場では気づけない。**
 *
 * **止まった状態から出られるところまでを 1 組にする** (#184)。
 *
 *   失効した            → 更新して復帰する
 *   更新に負けた         → **勝った側が保存するのを、限りのある回数だけ待つ** (#214)
 *   それでも駄目だった   → **再ログインへ戻す**（「何も見えない画面」で終わらせない）
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
 * **「使えない」を 1 つにまとめない** (#214)。**行き先が違う**——
 * **入り直せば直るもの**と、**入り直しても直らないもの**を混ぜると、
 * **直らない道へ人を送る。**
 */
export type UsableToken =
  | { readonly kind: "usable"; readonly accessToken: string }
  /** **入り直せば直る。** 失効していて、更新もできなかった。 */
  | { readonly kind: "needs-login" }
  /**
   * **入り直しても直らない** (#214)。**置き場が落ちている / 読めない / 書けない。**
   *
   * **「使えない」を 1 つにまとめない**のは、**行き先が違う**からである——
   * **入り直しへ誘うと、直らない道へ送る。** **元の版が 1 つにまとめていたのは
   * 「呼ぶ側が要るのは入口へ戻すかどうかだけ」**だったが、
   * **その前提が崩れた**（#213 のレビュー）。
   */
  | { readonly kind: "unavailable" };

/**
 * 負けた側が、**勝った側の保存を待つ間合い**。
 *
 * **`attempt` 回目の読み直しの前に呼ばれる。** **`false` を返したら打ち切る**——
 * **待ちの長さも回数も、ここを渡す側が持つ**（**この関数は時間を知らない**）。
 *
 * **既定値を置かない。** **置くと、配線し忘れた呼び出しが「待たない」まま
 * 静かに動く**——**症状は「たまに再ログインさせられる」**で、**再現できない。**
 */
export type WaitForWinnersSave = (attempt: number) => Promise<boolean>;

export type EnsureUsableTokenInput = {
  readonly store: UserTokenStore;
  readonly refresh: RefreshUserTokens;
  readonly now: Date;
  readonly waitForWinnersSave: WaitForWinnersSave;
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
    // **置き場の障害は、入り直しても直らない** (#214)
    return { kind: "unavailable" };
  }
  if (isUsable(current, now)) {
    return { kind: "usable", accessToken: (current as UserTokens).accessToken };
  }
  return { kind: "needs-login" };
}

/**
 * 勝った側の保存が現れるまで、**限りのある回数だけ読み直す** (#214)。
 *
 * **窓は `save` 1 回ぶん**（DB へ 1 往復）。**負けた側の失敗は GitHub へ 1 往復した
 * あと**なので**普通は勝った側が先に終わっている**が、**順序は保証されていない。**
 *
 * **錠は採らない。** **本番はインスタンスが複数ある**ので、**プロセス内の錠は
 * 別インスタンスの要求に効かない**——**効かない錠は、効いていることを
 * 確かめられないぶん無いより悪い。**
 *
 * **倒す先は 2 つある。** **待たなければ、切れる必要が無かった人を入口へ送る。**
 * **待ちすぎれば、画面が止まる**——**だから間合いは有限で、尽きたら諦める。**
 *
 * **`unavailable` は待たない。** **置き場が読めないのは、勝った側の保存とは
 * 別の障害**である——**待っても現れない。**
 */
async function usableFromStoreEventually(
  store: UserTokenStore,
  now: Date,
  waitForWinnersSave: WaitForWinnersSave,
): Promise<UsableToken> {
  let attempt = 0;
  for (;;) {
    const result = await usableFromStore(store, now);
    if (result.kind !== "needs-login") {
      return result;
    }
    attempt += 1;
    if (!(await waitForWinnersSave(attempt))) {
      return result;
    }
  }
}

export async function ensureUsableToken({
  store,
  refresh,
  now,
  waitForWinnersSave,
}: EnsureUsableTokenInput): Promise<UsableToken> {
  let saved: UserTokens | undefined;
  try {
    saved = await store.load();
  } catch {
    // **読めないことを「期限切れ」に化けさせない** (#214)——
    // **入り直しても直らない**ので、そう案内させない
    return { kind: "unavailable" };
  }
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
    // **待つのは保存のほうである** (#214)。
    return await usableFromStoreEventually(store, now, waitForWinnersSave);
  }

  // **保存できなければ「使える」とは言わない。** **GitHub 側で refresh token は
  // 1 度しか使えない**ので、**保存し損ねたまま進むと、次の要求で必ず失敗する**
  // ——**その場では動いて見え、次で壊れる。**
  try {
    await store.save(renewed);
  } catch {
    // **保存し損ねたまま「使える」とは言わない**のは変えない——
    // **倒す先を「入り直し」から「いま出せない」へ移す** (#214)
    return { kind: "unavailable" };
  }
  return { kind: "usable", accessToken: renewed.accessToken };
}
