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
import { refreshSession } from "./composition/session";

export async function middleware(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  await refreshSession({
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

export const config = {
  // **静的なファイルだけを外す。** **除外を足すと、その経路だけ古い Cookie で動く**
  // ——**足すときは `src/middleware.test.ts` が数えている経路を見ること。**
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
