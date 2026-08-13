/**
 * ユーザートークンが、いま使えるかを決める。
 *
 * **この App は "User-to-server token expiration" にオプトイン済み**なので、
 * **ユーザートークンは 8 時間で失効する**。失効したものをそのまま使うと、
 * **「ログインしているのに何も見えない」**という、**遅れて出る失敗**になる。
 *
 * **判断は通信の外に出す。** いまの時刻を引数で受けるので、
 * **8 時間待たずに確かめられる**（`installation-token` と同じ形。#131 / #137）。
 */

/** 期限だけを持つ、判断に要る最小の形。 */
export type ExpiringToken = {
  readonly expiresAt: Date;
};

/**
 * **期限の何秒前から使わないか。**
 *
 * 期限ちょうどまで使うと、**要求を送っている途中で切れうる**。切れた token は 401 を
 * 返すので、**症状が「権限が無い」と見分けられなくなる**。
 */
export const REFRESH_MARGIN_SECONDS = 60;

/**
 * その token を、いま使ってよいか。
 *
 * **持っていない場合も「使えない」へ倒す。** **無いことを「まだ切れていない」と
 * 読むと、空の資格で GitHub を叩くことになる。**
 */
export function isUsable(token: ExpiringToken | undefined, now: Date): boolean {
  if (token === undefined) {
    return false;
  }
  return token.expiresAt.getTime() - now.getTime() > REFRESH_MARGIN_SECONDS * 1000;
}
