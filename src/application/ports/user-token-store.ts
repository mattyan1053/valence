/**
 * ユーザーのトークンを置いておく口。
 *
 * **Supabase はログイン時にしか `provider_token` を返さず、保持しない。**
 * **セッションを更新しても復元されない**ので、**何もしないとログイン後に
 * ユーザーの権限で GitHub を叩けない**——**保存するのはそのためである。**
 *
 * **どこに置くか・どう暗号化するかは、この口の向こう側**である
 * （`AGENTS.md` §3。`application` は実装を知らない）。
 */

/**
 * ある 1 人ぶんのトークン。
 *
 * **refresh token も一緒に持つ。** **access token は 8 時間で失効する**ので、
 * **これが無いと、失効した時点で再ログイン以外の道が無くなる。**
 */
export type UserTokens = {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** access token が使えなくなる時刻。 */
  readonly expiresAt: Date;
};

export type UserTokenStore = {
  /**
   * 保存されているものを読む。**無ければ `undefined`。**
   *
   * **読めなかったら投げる。** **`undefined` を返すと、「まだログインしていない」と
   * 「読めなかった」が同じ顔になる**——**前者は再ログインで直り、後者は直らない。**
   */
  load(): Promise<UserTokens | undefined>;
  /** 更新したものを書く。**書けなかったら投げる。** */
  save(tokens: UserTokens): Promise<void>;
};
