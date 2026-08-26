/**
 * **マージを受け付ける口**（#331）。
 *
 * **infrastructure を直に触らない**（§3）。**合成ルートだけを呼ぶ。**
 *
 * **#342 が決めた形をそのまま使う**（#331 の指示）——**同じ穴を開け直さない。**
 *
 * - **成功をクエリ文字列から出さない**（**語彙に無ければ渡せない**）
 * - **POST の本文は Zod で検証する**
 * - **応答は 303**（**`boardRedirect` を使う。新しく書かない**）
 */

import { z } from "zod";
import type { MergePullRequestResult } from "../../../../../application/review-order/merge-pull-request";
import {
  mergePullRequestForCurrentUser,
  reportBoardActionUnavailable,
} from "../../../../../composition/auth";
import type { MergeNoticeKind } from "../../../../../ui/merge/merge-button";
import { boardRedirect } from "../board-redirect";

/**
 * 送られてきた PR 番号。**境界なので Zod で検証する**（§3。#342 のレビュー）。
 *
 * **`Number()` は `1e3` / `0x2a` / `Infinity` を受ける**ので、
 * **形（`regex`）で絞ってから数にする**（#90 と同じ形）。
 */
const pullRequestNumberSchema = z
  .string()
  .trim()
  .regex(/^[0-9]+$/)
  .transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));

export function pullRequestNumberFrom(value: unknown): number | undefined {
  const parsed = pullRequestNumberSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * 送られてきた head の commit（#331 のレビュー）。**境界なので Zod で検証する**。
 *
 * **形まで見る。** **そのまま GitHub の要求へ載せる値**なので、
 * **commit として有り得ないものを通さない**（**40 桁の 16 進**）。
 *
 * **無ければ通さない。** **省略された要求を「固定しないマージ」として通すと、
 * ボタンを経由しない要求で、見せていない head がマージできる**
 * ——**フォームを直せば済む側に穴を残さない。**
 */
const headShaSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{40}$/);

export function headShaFrom(value: unknown): string | undefined {
  const parsed = headShaSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * 結果を、画面が出せる語彙へ寄せる。
 *
 * **成功は載せない**（#342 のレビュー）——**`?merge=` は利用者が任意に作れる。**
 * **`merged` を載せると、マージしていない人が URL を開くだけで
 * 「マージしました」と出る**——**取り消せない事実の主張**である。
 *
 * **失敗側は載せてよい**（**断言している内容が「起きなかった」**）。
 *
 * **`not-found` をそのまま返さない**（§6）——**見えないリポジトリの存在を教える。**
 */
export function mergeOutcomeParam(result: MergePullRequestResult): MergeNoticeKind | undefined {
  switch (result.kind) {
    case "merged":
      // **何も載せずに盤面へ戻す**
      return undefined;
    case "forbidden":
      return "forbidden";
    case "not-mergeable":
      return "not-mergeable";
    case "dependency-pending":
      // **土台が残っている**（#345）——**番号は載せない**（**URL は利用者が
      // 作れる**ので、**盤面が描いている依存のほうが確かである**）
      return "dependency-pending";
    case "not-orderable":
      return "not-orderable";
    case "base-changed":
      return "base-changed";
    default:
      // **`signed-out` / `needs-login` / `unavailable` / `not-found`**
      return "unavailable";
  }
}

/**
 * **サーバ側に残す理由** (#506 の 2)。
 *
 * **`unavailable` は 4 つをまとめた語**である（`signed-out` / `needs-login` /
 * `not-found` / `unavailable`）——**画面では分けない**（§6）**が、押せない理由が
 * 誰にも分からないままになっていた。**
 *
 * **押した人へ理由が届いているものは残さない**（`forbidden` / `not-mergeable` /
 * `dependency-pending` / `not-orderable` / `base-changed` / `merged`）。
 */
export function mergeUnavailableReason(result: MergePullRequestResult): string | undefined {
  return mergeOutcomeParam(result) === "unavailable" ? result.kind : undefined;
}

export async function POST(
  request: Request,
  { params }: { readonly params: Promise<{ readonly owner: string; readonly name: string }> },
): Promise<Response> {
  const { owner, name } = await params;
  const form = await request.formData().catch(() => undefined);
  const number = pullRequestNumberFrom(form?.get("number"));
  const headSha = headShaFrom(form?.get("sha"));

  if (number === undefined || headSha === undefined) {
    // **読めない要求で GitHub を叩かない。** **commit が無い要求も通さない**
    // ——**通すと、見せていない head がマージできる。**
    reportBoardActionUnavailable("merge", "unreadable-request");
    return boardRedirect(request, { owner, name }, { param: "merge", value: "unavailable" });
  }

  const result = await mergePullRequestForCurrentUser({ owner, name }, number, headSha);
  const outcome = mergeOutcomeParam(result);
  // **まとめた語を、まとめる前の形で残す** (#506 の 2)
  const reason = mergeUnavailableReason(result);
  if (reason !== undefined) {
    reportBoardActionUnavailable("merge", reason);
  }
  // **成功のときは何も載せない**（上記）
  return boardRedirect(
    request,
    { owner, name },
    outcome === undefined ? undefined : { param: "merge", value: outcome },
  );
}
