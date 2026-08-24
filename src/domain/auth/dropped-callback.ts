/**
 * **戻ってくるはずのものが、戻ってこなかった** (#455)。
 *
 * **戻り先が GoTrue の許可一覧に当たらないと、GoTrue は黙って `site_url` へ落として戻す**
 * ——**`/auth/callback` の Route Handler は呼ばれない**ので、**落ちた段の記録**（#248）
 * **も残らない。** **利用者に見えるのは、ログインしていないときの画面だけ**である。
 *
 * **こちらが落としたとは言えない。** **落としているのは GoTrue** で、**こちらから
 * 分かるのは「`code` が、来るはずのない場所へ来た」**まで（`bin/doctor` の
 * `[分かりません]` と同じ側）。
 *
 * **`/` に決め打たない。** **落ちる先は `site_url`** なので、**設定を変えれば別の
 * path になる**——**見るのは「`/auth/callback` ではないところへ来た」**ほうである。
 */

/** `code` を受け取ってよい唯一の場所。 */
const CALLBACK_PATH = "/auth/callback";

/** その要求は、GoTrue が落として戻したものに見えるか。 */
export function looksLikeDroppedCallback(request: {
  readonly pathname: string;
  readonly hasCode: boolean;
}): boolean {
  return request.hasCode && request.pathname !== CALLBACK_PATH;
}
