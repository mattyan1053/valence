/**
 * **承認を受け付ける口**（#330）。
 *
 * **infrastructure を直に触らない**（§3）。**合成ルートだけを呼ぶ。**
 *
 * **判定はここに書き写さない。** **押してよいかを決めるのは
 * `approvePullRequest`**——**ここがするのは、受け取った本文を内側の語彙へ直し、
 * 結果を押した人へ戻すことだけ**である。
 *
 * **結果は行き先に載せて戻す**（`?approve=<kind>`）。**押せなかった理由が
 * 伝わること**が、この Issue の完了条件のひとつである。
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import type { ApprovePullRequestResult } from "../../../../../application/review-order/approve-pull-request";
import { approvePullRequestForCurrentUser } from "../../../../../composition/auth";
import type { ApproveNoticeKind } from "../../../../../ui/approve/approve-button";

/**
 * 送られてきた PR 番号。**境界なので Zod で検証する**（`AGENTS.md` §3。#342 のレビュー）。
 *
 * **自前の正規表現と `Number()` で書き直さない。** **いま同じ制約を満たせていても、
 * 境界ごとに別のものが育つ**——**#342 は「同じ規則を 2 箇所に置かない」を
 * 自己承認の側では守っておきながら、ここで踏んでいた。**
 *
 * **フォームから来る値は文字列である。** **`Number()` に通しただけで使わない**
 * ——**`""` は `0` に、空白は無視され**、**どの PR とも違う相手へ要求が出る。**
 *
 * **1 以上・安全に扱える整数だけを通す**（**PR 番号がそれ以外になることは無い**）。
 */
const pullRequestNumberSchema = z
  .string()
  .trim()
  // **形で確かめてから数にする**——**`Number()` は `1e3` も `0x2a` も受ける**ので、
  // **通してよいものを並べる側で決める**（#90 と同じ形）
  .regex(/^[0-9]+$/)
  .transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));

export function pullRequestNumberFrom(value: unknown): number | undefined {
  const parsed = pullRequestNumberSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * 結果を、画面が出せる語彙へ寄せる。
 *
 * **成功は載せない**（#342 のレビュー）——**`?approve=` は利用者が任意に作れる。**
 * **`approved` を載せると、承認していない人が URL を開く・再読み込みする・
 * 共有されたリンクを踏むだけで「承認しました」と出る**——**承認は 1 度も
 * 起きていないのに、画面がそう主張する。**
 *
 * **失敗側は載せてよい。** **同じ穴だが、断言している内容が「起きなかった」**である
 * ——**偽装しても、押していない人が「押せなかった」と読むだけ**で、
 * **次の行動が変わらない。** **`approved` は取り消せない事実の主張**で、
 * **見た人はマージへ進む。**
 *
 * **`not-found` をそのまま返さない**（§6）——**見えないリポジトリの存在を教える。**
 * **ログインの状態も分けない**——**押した人にとっては「いま押せなかった」**である。
 */
export function approveOutcomeParam(
  result: ApprovePullRequestResult,
): ApproveNoticeKind | undefined {
  switch (result.kind) {
    case "approved":
      // **何も載せずに盤面へ戻す**
      return undefined;
    case "forbidden":
      return "forbidden";
    case "self-approval":
      return "self-approval";
    default:
      // **`signed-out` / `needs-login` / `unavailable` / `not-found`**
      return "unavailable";
  }
}

/**
 * 盤面へ戻す応答。
 *
 * **303 で戻す**（#342 のレビュー）。**`next/navigation` の `redirect()` は
 * Route Handler では 307** で、**ブラウザはメソッドと本文を保持したまま再送する**
 * ——**盤面に POST handler は無い**ので、**承認が成功しても 405 で終わり**、
 * **盤面にも、押せなかった理由にも到達できない。**
 * **POST-Redirect-GET にする**（`src/app/auth/logout/route.ts` と同じ形）。
 *
 * **戻り先は要求が来たオリジンの上に組み立てる**（`src/app/auth/urls.ts` と同じ理由）
 * ——**設定へ書き固めると、`localhost` と `127.0.0.1` で食い違う。**
 *
 * **owner / name は経路の 1 区切りとして入れる**——**そのまま繋ぐと、
 * `..` や `?` を含む名前で別の場所へ戻せる。**
 */
export function boardRedirect(
  request: Request,
  repository: { readonly owner: string; readonly name: string },
  outcome: ApproveNoticeKind | undefined,
): NextResponse {
  const board = new URL(
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`,
    request.url,
  );
  if (outcome !== undefined) {
    board.searchParams.set("approve", outcome);
  }
  return NextResponse.redirect(board, { status: 303 });
}

export async function POST(
  request: Request,
  { params }: { readonly params: Promise<{ readonly owner: string; readonly name: string }> },
): Promise<Response> {
  const { owner, name } = await params;
  const form = await request.formData().catch(() => undefined);
  const number = pullRequestNumberFrom(form?.get("number"));

  if (number === undefined) {
    // **読めない要求で GitHub を叩かない**
    return boardRedirect(request, { owner, name }, "unavailable");
  }

  const result = await approvePullRequestForCurrentUser({ owner, name }, number);
  // **成功のときは何も載せない**（上記）——**押した結果は盤面そのもので確かめる**
  return boardRedirect(request, { owner, name }, approveOutcomeParam(result));
}
