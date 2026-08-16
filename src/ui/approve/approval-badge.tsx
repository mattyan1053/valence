/**
 * **承認済みかどうかを盤面に出す**（#343）。
 *
 * **表示に専念する**（§3）。**どこから来た状態かは知らない**——
 * **判定は `viewRepositoryBoard` と `PullRequestApprovals` が持つ。**
 *
 * **「承認されていない」は何も出さない。** **出す語彙に入れないのは、
 * 盤面のほとんどの行がそれだから**である——**全部の行に「未承認」と書いても、
 * 交通整理の役には立たない。** **分からないときだけは、そう言う。**
 */

/**
 * 出す状態。**「承認されていない」を並べない**（上記）。
 *
 * **`unknown` を落とさない。** **読めなかった行を黙らせると、
 * 「承認されていない」と見分けが付かない**——**押した人はもう一度押す**
 * （**#343 が消しに来た形**）。
 */
export type ApprovalDisplayKind = "approved" | "unknown";

/** 画面へ出す文面。**行き先が違うものを 1 つにまとめない。** */
export function approvalLabel(kind: ApprovalDisplayKind): string {
  switch (kind) {
    case "approved":
      return "承認済み";
    case "unknown":
      // **「承認されていない」とは言わない**——**こちらが見ていないだけ**である
      return "承認の状態を取得できませんでした";
  }
}

export function ApprovalBadge({ kind }: { readonly kind: ApprovalDisplayKind }) {
  return (
    <span className={kind === "approved" ? "text-sm font-semibold" : "text-sm opacity-70"}>
      {approvalLabel(kind)}
    </span>
  );
}
