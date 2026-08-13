/**
 * ログインを始める——**押されたときだけ。**
 *
 * **`GET /auth/login` を開いただけでは始まらない** (#224 のレビュー)。
 * **始まってしまうと、キャンセルした人がキャンセルした先でまた認可画面に立たされる**
 * ——**戻す仕組みなのに、戻した先が同じ経路の入口**である（#184 の形）。
 *
 * **POST だけを受ける。** **GET で始められると、`<img src>` 1 つで他人を
 * 認可画面へ送れる**（Route Handler は GET を定義しなければ 405 を返す）。
 */

import { NextResponse } from "next/server";
import { githubLoginUrl } from "../../../../composition/auth";
import { callbackUrl } from "../../urls";

export async function POST(request: Request): Promise<NextResponse> {
  return NextResponse.redirect(await githubLoginUrl(callbackUrl(request)), { status: 303 });
}
