/**
 * **1 クリックで Approve を出すボタン**（#330。**MVP の 3 番目**）。
 *
 * **表示に専念する**（§3）。**送る先は props で受ける**ので、
 * **この部品は application も composition も知らない**（`ui-has-no-io`）。
 *
 * **番号は本文に載せて送る。** **ボタンが「どの PR か」を持たないと、
 * 押した先で対象が決まらない**——**別の PR へ承認が出る。**
 */

/** 押した結果。**画面へ出す語彙で持つ**（`application` の型は import しない）。 */
export type ApproveNoticeKind = "approved" | "forbidden" | "self-approval" | "unavailable";

export type ApproveButtonProps = {
  readonly number: number;
  /** 送る先。**どこへ送るかを決めるのは、この部品の外**である。 */
  readonly action: string;
  /**
   * **押しても断られると分かっているとき**に立てる。
   *
   * **これは表示の都合であって、認可ではない。** **判定は
   * `approvePullRequest` が持つ**——**押せてしまっても、そこで止まる。**
   */
  readonly disabled?: boolean;
};

/**
 * 押せなかった理由。**行き先が違うものを 1 つにまとめない。**
 *
 * **`forbidden` と `self-approval` を分ける。** **権限が足りないのか、
 * 権限はあるが自分の PR なのか**で、**押した人が次に取る行動が変わる**
 * （**権限を貰いに行く**のか、**他の人に頼む**のか）。
 *
 * **GitHub の文面を載せない**（§6）——**応答には、そのユーザーの持ち物が並びうる。**
 */
export function approveNotice(kind: ApproveNoticeKind): string {
  switch (kind) {
    case "approved":
      return "承認しました。";
    case "forbidden":
      return "このリポジトリへ書き込む権限がないため、承認できません。";
    case "self-approval":
      // **GitHub の制限をそのまま伝える。** **こちらが弾いたのではない**
      return "自分が出した PR は、自分では承認できません。ほかの人に依頼してください。";
    case "unavailable":
      // **入り直しても直らない。** **再ログインへ案内すると、故障を認証切れとして隠す**
      return "いま承認できませんでした。しばらくしてから試してください。";
  }
}

export function ApproveButton({ number, action, disabled }: ApproveButtonProps) {
  return (
    <form action={action} method="post">
      {/* **どの PR かを、送る本文が持つ** */}
      <input type="hidden" name="number" value={number} />
      <button
        className="rounded border px-2 py-1 text-sm disabled:opacity-50"
        disabled={disabled}
        type="submit"
      >
        Approve
      </button>
    </form>
  );
}
