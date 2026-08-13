/**
 * ログインを始める——**GitHub の認可画面へ送る。**
 *
 * **戻り先は外から受けない。** **クエリで受けると、そこが開いた転送になる**
 * ——**認可のコードを別のホストへ渡せてしまう。**
 */

import { NextResponse } from "next/server";
import { githubLoginUrl } from "../../../composition/auth";
import { callbackUrl } from "../urls";

export async function GET(request: Request): Promise<NextResponse> {
  return NextResponse.redirect(await githubLoginUrl(callbackUrl(request)));
}
