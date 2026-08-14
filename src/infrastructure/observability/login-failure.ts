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
