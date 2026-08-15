/**
 * Approve の結果を、押した人に読める文へ畳む（#315）。
 *
 * **GitHub の応答は出さない**（`AGENTS.md` §6）——**他人の持ち物が混ざりうる**ので、
 * **境界が分類したものから、こちらで文を作る。**
 *
 * **結果ごとに文面を分ける。** **「できませんでした」に丸めると、入り直せば直るのか、
 * App の権限が足りないのかが分からない**——**押した人にできることが変わる。**
 */

/**
 * 押した結果として扱う値。
 *
 * **URL から来る**（**戻り先の query に載る**）ので、**誰でも書ける**——
 * **知らない値は結果として扱わない**（§6。**外から来たものを検証してから使う**）。
 */
export const APPROVAL_OUTCOMES = [
  "approved",
  "signed-out",
  "needs-login",
  "unavailable",
  "not-found",
  "not-permitted",
  "not-reviewable",
  "gone",
] as const;

export type ApprovalOutcome = (typeof APPROVAL_OUTCOMES)[number];

export function isApprovalOutcome(value: unknown): value is ApprovalOutcome {
  return APPROVAL_OUTCOMES.some((outcome) => outcome === value);
}

export function approvalNotice(outcome: ApprovalOutcome): string {
  switch (outcome) {
    case "approved":
      return "Approve しました。";
    case "signed-out":
      return "ログインすると Approve できます。";
    case "needs-login":
      return "ログインの期限が切れました。入り直してから、もう一度押してください。";
    case "unavailable":
      // **入り直しても直らない。** **再ログインへ案内すると、故障を認証切れとして隠す**
      return "いま Approve できませんでした。しばらくしてから、もう一度押してください。";
    case "not-found":
      // **「見えない」と「無い」を分けない**（§6）——**分けた瞬間に存在を教える**
      return "そのリポジトリは見つかりませんでした。";
    case "not-permitted":
      return "この App には Approve の権限がありません。インストール時の権限を確認してください。";
    case "not-reviewable":
      // **自分の PR は Approve できない**など、GitHub が受け付けない側
      return "GitHub がこの Approve を受け付けませんでした（自分の PR には出せません）。";
    case "gone":
      return "その PR は見つかりませんでした（閉じられたか、番号が変わっています）。";
  }
}
