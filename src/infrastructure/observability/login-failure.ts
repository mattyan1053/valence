/**
 * **ログインが落ちた段だけを、サーバ側へ残す** (#248)。
 *
 * **握り潰していたのは正しい判断だった。** **例外には token が混ざりうる**ので、
 * **画面へ出さないのは合っている**（`AGENTS.md` §6）——**問題は、どこにも残らないこと**
 * だった。**利用者がログインできず、`docker exec` で環境変数を人が読むまで
 * 原因が分からなかった**（2026-08-14 に実際に踏んだ）。
 *
 * **足すのは「どこで落ちたか」だけ**である。**中身は 1 文字も残さない。**
 *
 * **書き出す口を引数で受ける** (#131 / #137 と同じ形)——**試験が、本物の標準エラーを
 * 汚さずに「出していないこと」を見られる。**
 */

import type { LoginStage } from "../../application/auth/complete-login";

/**
 * 例外の**種類だけ**を取る。
 *
 * **`message` を読まない。** **何が入るか保証できない**（応答本文がそのまま
 * 入っていることがある）——**`cause` も同じ**なので、**辿らない。**
 *
 * **`Error` 以外も投げられる**（`throw "文字列"` も `throw {token}` も書ける）。
 * **種類が分からないときこそ、中身を出さない**——**`typeof` までで止める。**
 */
function kindOf(error: unknown): string {
  if (error instanceof Error) {
    // **クラス名だけ。** `ZodError` / `TypeError` / `Error` のような、書いた人が付けた名前である
    return error.constructor.name;
  }
  return typeof error;
}

/**
 * 落ちた段を 1 行だけ残す。
 *
 * **成功した周回では呼ばれない。** **毎回鳴る警告は、そのうち読まれなくなる。**
 */
export function reportLoginFailure(
  stage: LoginStage,
  error: unknown,
  write: (line: string) => void = console.error,
): void {
  write(`[auth] login failed stage=${stage} error=${kindOf(error)}`);
}

/**
 * **戻ってくるはずのコールバックが来なかったことを、1 行だけ残す** (#455)。
 *
 * **`/auth/callback` が呼ばれない**ので、**上の「落ちた段」は出ない**——**残るのは
 * これだけ**である。**次に見る場所（戻り先の許可一覧）まで書く**：**症状だけ残しても
 * 人は動けない**（**実際、原因に辿り着くまでに `curl` と `docker exec` が要った**）。
 *
 * **こちらが落としたとは書かない。** **落としているのは GoTrue** で、**こちらから
 * 分かるのは「戻ってこなかった」まで**である。
 *
 * **`code` は受けない。** **path しか受け取らない形にしても、問い合わせを付けたまま
 * 渡す呼び出しは書ける**ので、**この口で落とす**（§6。**交換できる値を残さない**）。
 */
export function reportDroppedCallback(
  pathname: string,
  write: (line: string) => void = console.error,
): void {
  const path = pathname.split("?")[0] ?? "";
  write(
    `[auth] callback did not arrive: code came to ${path} instead of /auth/callback` +
      "（戻り先が許可一覧に当たらないと、site_url へ落とされて戻る。supabase/config.toml の additional_redirect_urls と site_url、本番は AUTH_ALLOWED_ORIGINS を見ること）",
  );
}
