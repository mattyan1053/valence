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

import type { ApprovePullRequestResult } from "../../../../../application/review-order/approve-pull-request";
import {
  approvePullRequestForCurrentUser,
  reportBoardActionUnavailable,
} from "../../../../../composition/auth";
import type { ApproveNoticeKind } from "../../../../../ui/approve/approve-button";
import { submittedPullRequestNumberFrom } from "../../../../query-input";
import { boardRedirect, submittedBallFilter } from "../board-redirect";

/**
 */

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
 * **サーバ側に残す理由** (#506 の 2)。
 *
 * **`unavailable` は 4 つをまとめた語**である（`signed-out` / `needs-login` /
 * `not-found` / `unavailable`）——**画面では分けない**（§6。**見えないリポジトリの
 * 存在を教える**）**が、押せない理由が誰にも分からないままになっていた。**
 *
 * **押した人へ理由が届いているものは残さない**（`forbidden` / `self-approval` /
 * `approved`）——**毎回鳴る記録は、そのうち読まれなくなる**（#248）。
 */
export function approveUnavailableReason(result: ApprovePullRequestResult): string | undefined {
  if (approveOutcomeParam(result) !== "unavailable") {
    return undefined;
  }
  // **握り潰した例外の落ちどころも添える** (#506 の 2-b)——**`unavailable` だけでは
  // 「なぜ」が出ない。** **種類だけ**（中身は `errorKind` が落としている。§6）。
  return result.kind === "unavailable" && result.reason !== undefined
    ? `${result.kind}/${result.reason}`
    : result.kind;
}

/**
 * **要求を受けてから戻すまで** (#510 のレビュー)。
 *
 * **受け口を引数で渡す**——**`POST` から呼ぶと、composition が本物を掴む**ので、
 * **「記録の口を呼んでいること」を試験から見られない**（**呼び出しを消しても
 * 部品の試験は緑のまま**だった）。**モックは使わない**（`AGENTS.md` §4）
 * ——**インメモリの実装を渡す形にする。**
 */
export type ApproveDeps = {
  readonly approve: (
    repository: { readonly owner: string; readonly name: string },
    number: number,
  ) => Promise<ApprovePullRequestResult>;
  /** 押せなかった理由を残す口（`reportBoardActionUnavailable`）。 */
  readonly report: (action: "approve", kind: string) => void;
};

export async function respondToApprove(
  request: Request,
  repository: { readonly owner: string; readonly name: string },
  deps: ApproveDeps,
): Promise<Response> {
  const form = await request.formData().catch(() => undefined);
  const number = submittedPullRequestNumberFrom(form?.get("number"));
  // **絞ったまま押せるようにする**（#667）——**押した人は絞った一覧に居る**ので、
  // **理由を出す先も、次に押す先も、そこである**
  const ball = submittedBallFilter(form);

  if (number === undefined) {
    // **読めない要求で GitHub を叩かない**
    deps.report("approve", "unreadable-request");
    return boardRedirect(request, repository, { param: "approve", value: "unavailable" }, ball);
  }

  const result = await deps.approve(repository, number);
  const outcome = approveOutcomeParam(result);
  // **まとめた語を、まとめる前の形で残す** (#506 の 2)
  const reason = approveUnavailableReason(result);
  if (reason !== undefined) {
    deps.report("approve", reason);
  }
  // **成功のときは何も載せない**（上記）——**押した結果は盤面そのもので確かめる**
  return boardRedirect(
    request,
    repository,
    outcome === undefined ? undefined : { param: "approve", value: outcome },
    ball,
  );
}

export async function POST(
  request: Request,
  { params }: { readonly params: Promise<{ readonly owner: string; readonly name: string }> },
): Promise<Response> {
  const { owner, name } = await params;
  return respondToApprove(
    request,
    { owner, name },
    { approve: approvePullRequestForCurrentUser, report: reportBoardActionUnavailable },
  );
}
