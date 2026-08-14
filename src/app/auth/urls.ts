/**
 * この App 自身の URL。
 *
 * **要求が来たオリジンから組み立てる。** **設定へ書くと、`localhost` と
 * `127.0.0.1` のどちらで開いたかで Cookie が食い違う**——**片方でだけ
 * ログインが完了しない**（`supabase/config.toml` の注記と同じ理由）。
 */

/** コールバックの戻り先。**外から受けない**（開いた転送を作らない）。 */
export function callbackUrl(request: Request): string {
  return new URL("/auth/callback", request.url).toString();
}

/** ログインし直す入口。 */
export function loginUrl(request: Request): string {
  return new URL("/auth/login", request.url).toString();
}

/** ログイン後・ログアウト後に見せる場所。 */
export function homeUrl(request: Request): string {
  return new URL("/", request.url).toString();
}
