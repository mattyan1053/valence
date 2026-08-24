/**
 * **更新されたセッションが返る唯一の境界**（#214 の 1）。
 *
 * **画面からは Cookie を書けない。** **サーバコンポーネントの `cookies()` は
 * 読み取り専用**なので、**更新されたセッションはどこにも残らず、次の要求で切れる。**
 *
 * **middleware を選んだのは「必ず通る」から**である。**Route Handler は
 * 呼ばれたときだけ走る**ので、**「画面が呼ぶ」形にすると、呼び忘れた画面が
 * 1 つできた瞬間に穴が開く。** **通ることは `src/middleware.test.ts` が数える。**
 *
 * **ここでは行き先を決めない。** **更新するのが境界、読むのが画面**である。
 */

import { type NextRequest, NextResponse } from "next/server";
import { reportDroppedCallback } from "./composition/auth";
import { refreshSession } from "./composition/session";
import { looksLikeDroppedCallback } from "./domain/auth/dropped-callback";
import type { SessionCookieSinks } from "./infrastructure/supabase/session-cookies";

/**
 * セッションを更新する側。**差し替えるための引数であって、抽象ではない**（#64 と同じ形）。
 *
 * **`middleware` からは渡せない。** **Next.js が第 2 引数に `NextFetchEvent` を渡す**
 * ので、**既定値のある引数を足すと、実物ではそちらが入る**——**分けてある。**
 */
export type SessionRefresher = (sinks: SessionCookieSinks) => Promise<void>;

/** Next.js が呼ぶ入口。**結線だけを持つ。** */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  return await refreshedResponse(request, refreshSession);
}

/**
 * 戻ってこなかったコールバックを残す側。**`SessionRefresher` と同じく、差し替える
 * ための引数**である（**抽象ではない**）。
 */
export type DroppedCallbackReport = (pathname: string) => void;

export async function refreshedResponse(
  request: NextRequest,
  refresh: SessionRefresher,
  report: DroppedCallbackReport = reportDroppedCallback,
): Promise<NextResponse> {
  // **ここで見るのは「必ず通る」から** (#455)。**戻り先が許可一覧に当たらないと、
  // GoTrue は `site_url` へ落として戻す**——**`/auth/callback` は呼ばれない**ので、
  // **あちらに置いた記録**（#248）**も出ない。** **画面に置くと、`/` を描く経路が
  // 変わった日に落ちる。**
  //
  // **交換はしない**（#455 の範囲外）。**`/` でも受けられるようにすると、塞ぎたい穴が
  // 塞がらないまま動く**——**ここは、来たことを残すだけ**である。
  if (
    looksLikeDroppedCallback({
      pathname: request.nextUrl.pathname,
      hasCode: request.nextUrl.searchParams.has("code"),
    })
  ) {
    report(request.nextUrl.pathname);
  }

  let response = NextResponse.next({ request });

  await refresh({
    read: () => request.cookies.getAll().map(({ name, value }) => ({ name, value })),
    toRequest: ({ name, value }) => {
      request.cookies.set(name, value);
    },
    // **差し替えた要求から作り直す。** **応答は作った時点の要求を写して持つ**ので、
    // **作り直さないと、この要求の続き（画面）は古い Cookie を読む。**
    renew: () => {
      response = NextResponse.next({ request });
    },
    toBrowser: ({ name, value, options }) => {
      response.cookies.set(name, value, options);
    },
  });

  return response;
}

/**
 * **Node.js で走らせる** (#252 のレビュー)。**既定の Edge では設定を読めない。**
 *
 * **Edge の `process.env` には、Next.js が注ぎ込んだものしか入らない。**
 * **注ぎ込まれるのは `process.env.X` の形で書かれた参照だけ**で、
 * **`readSupabaseConnection(process.env)` のようにオブジェクトごと渡した先の
 * 参照は、名前が文字列のまま残る**——**ビルドした middleware の manifest を見ると、
 * `env` に入っているのは Next.js 自身の鍵だけ**である（**`.env` に 3 つとも
 * あるのに入らない**）。**そのまま出すと、要求のたびに「環境変数が設定されて
 * いない」で落ちる。**
 *
 * **静的に読める形へ書き換えて Edge に留まる道もある**が、**環境変数の名前を
 * `session.ts` の外にもう 1 組持つことになる**（§5。**片方だけ古くなる**）。
 * **ここは速さより、設定を 1 か所に置くほうを採る。**
 */
export const runtime = "nodejs";

export const config = {
  // **静的なファイルだけを外す。** **除外を足すと、その経路だけ古い Cookie で動く**
  // ——**足すときは `src/middleware.test.ts` が数えている経路を見ること。**
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
