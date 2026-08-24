/**
 * この App 自身の URL。
 *
 * **開いたオリジンから組み立てる。** **設定へ書くと、`localhost` と
 * `127.0.0.1` のどちらで開いたかで Cookie が食い違う**——**片方でだけ
 * ログインが完了しない**（`supabase/config.toml` の注記と同じ理由）。
 *
 * **`request.url` は「開いたオリジン」ではない** (#451)。**dev サーバは
 * `--hostname 0.0.0.0` で待ち受けている**ので、**`127.0.0.1:3000` から叩いても
 * `request.url` は `http://0.0.0.0:3000/…`** になる——**GoTrue の許可一覧に
 * 当たらず、`site_url` へ落ちて `/auth/callback` が呼ばれない**（実測）。
 * **ブラウザが使ったオリジンは `Host`**（プロキシごしなら `X-Forwarded-Host`）**にある。**
 *
 * **`Host` は外から来る。** **そのまま戻り先にすると、開いた転送になる**
 * ——**`NextResponse.redirect(homeUrl(request))` が、その host へ人を送る。**
 * **許可一覧と突き合わせ、当たらなければ組み立てない。**
 *
 * **許可の正は `supabase/config.toml`** である（`allowedRedirectOrigins`）
 * ——**GoTrue が突き合わせるのと同じ一覧**を見る。**アプリ側に 2 つ目を置かない。**
 */

import { allowedRedirectOrigins } from "../../composition/auth";

/**
 * 開いたオリジン。**許可一覧に載っているものだけを返す。**
 *
 * **落ちるほうへ倒す** ——**当たらないまま組み立てると、開いた転送になる。**
 * **黙って既定へ落とさない**（**GoTrue が `site_url` へ落とす形と同じことを、
 * こちら側でもやることになる**）。
 */
function openedOrigin(request: Request): string {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const allowed = allowedRedirectOrigins();
  const matched = allowed.find((origin) => new URL(origin).host === host);
  if (matched === undefined) {
    throw new Error(
      `戻り先として許可されていない host です: ${host ?? "(Host なし)"}（許可: ${allowed.join(", ") || "なし"}）`,
    );
  }
  return matched;
}

/** コールバックの戻り先。**外から受けない**（開いた転送を作らない）。 */
export function callbackUrl(request: Request): string {
  return new URL("/auth/callback", openedOrigin(request)).toString();
}

/** ログインし直す入口。 */
export function loginUrl(request: Request): string {
  return new URL("/auth/login", openedOrigin(request)).toString();
}

/** ログイン後・ログアウト後に見せる場所。 */
export function homeUrl(request: Request): string {
  return new URL("/", openedOrigin(request)).toString();
}
