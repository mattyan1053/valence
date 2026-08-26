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
// **種類だけを取る判断は 1 箇所**（#506 の 2-b で application へ移した）
// ——**握り潰した側でも同じことが要る**ので、**両方から使えるところに置いてある。**
import { errorKind } from "../../application/observability/error-kind";

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
  write(`[auth] login failed stage=${stage} error=${errorKind(error)}`);
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
 *
 * **指すのは GoTrue が見ている設定だけ** (#458 のレビュー)。**`AUTH_ALLOWED_ORIGINS` は
 * アプリが `Host` を検証するためのもの**で、**GoTrue は見ない**——**指すと、正しい値を
 * 確かめた人がそこで調査を止める。** **本番の GoTrue が見ているのは Supabase の Auth
 * 設定**である（`supabase/config.toml` は開発のもの）。
 *
 * **突き合わせるのは戻り先の完全な URL** である——**こちら側の許可一覧はオリジンだけを
 * 見る**（`redirect-allowlist.ts`）ので、**オリジンが合っていても、`/auth/callback` を
 * 含む URL が GoTrue で許可されていなければ落ちる。**
 */
export function reportDroppedCallback(
  pathname: string,
  write: (line: string) => void = console.error,
): void {
  const path = pathname.split("?")[0] ?? "";
  write(
    `[auth] callback did not arrive: code came to ${path} instead of /auth/callback` +
      "（戻り先が許可一覧に当たらないと、site_url へ落とされて戻る。開発は supabase/config.toml の site_url と additional_redirect_urls、本番は Supabase の Auth 設定（Site URL / Redirect URLs）を、戻り先の完全な URL で確かめること）",
  );
}
