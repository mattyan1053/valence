/**
 * コールバック——**`code` をセッションへ交換し、GitHub のトークンを保存する。**
 *
 * **`code` は外から来る値なので、使う前に形を確かめる**（`AGENTS.md` §6）。
 * **`state` と PKCE の検証子を突き合わせるのは Supabase のクライアント**である
 * ——**確かめる者を 2 人にしない。**
 *
 * **倒す先は 2 つある。** **入れない**（正当なログインを弾く）と、
 * **入れすぎ**（確かめずに受ける）——**どちらも試験で押さえてある。**
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { completeGithubLogin } from "../../../composition/auth";
import { homeUrl, loginUrl } from "../urls";

/** GitHub が返す認可コード。**空でない 1 語**だけを通す。 */
const codeSchema = z.string().trim().min(1);

export async function GET(request: Request): Promise<NextResponse> {
  const code = codeSchema.safeParse(new URL(request.url).searchParams.get("code"));
  if (!code.success) {
    // **理由を画面へ書かない。** **戻す先はいつも入口である。**
    return NextResponse.redirect(loginUrl(request));
  }

  let result: Awaited<ReturnType<typeof completeGithubLogin>>;
  try {
    result = await completeGithubLogin(code.data);
  } catch {
    // **例外の中身を出さない**（token が入りうる。§6）。**入口へ戻す。**
    return NextResponse.redirect(loginUrl(request));
  }

  // **「入れた」と言えるのは、保存まで済んだときだけ**である。
  return NextResponse.redirect(result.kind === "signed-in" ? homeUrl(request) : loginUrl(request));
}
