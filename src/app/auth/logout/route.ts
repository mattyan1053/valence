/**
 * ログアウト——**セッションと、保存したトークンを消す。**
 *
 * **POST だけを受ける。** **GET で消せると、`<img src>` 1 つで他人を
 * ログアウトさせられる**（Route Handler は GET を定義しなければ 405 を返す）。
 */

import { NextResponse } from "next/server";
import { signOutCurrentUser } from "../../../composition/auth";
import { homeUrl } from "../urls";

export async function POST(request: Request): Promise<NextResponse> {
  await signOutCurrentUser();
  return NextResponse.redirect(homeUrl(request), { status: 303 });
}
