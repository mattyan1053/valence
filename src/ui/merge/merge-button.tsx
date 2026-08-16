/**
 * **1 クリックで Merge するボタン**（#331。**MVP の 3 番目**）。
 *
 * **表示に専念する**（§3）。**送る先は props で受ける**ので、
 * **この部品は application も composition も知らない**（`ui-has-no-io`）。
 *
 * **`ApproveButton` と同じ形にしてある。** **3 回目まで抽象化しない**（§5）——
 * **いまは 2 つ目**で、**まとめるとどちらの文面も直しにくくなる。**
 */

/**
 * **押せなかった理由。** **成功を並べない**（#342 のレビュー）——
 * **これは URL から渡ってくる値**であり、**利用者が任意に作れる。**
 * **`merged` を並べた瞬間、マージしていない人が「マージしました」を出せる**
 * （**取り消せない事実の主張**）。
 */
export type MergeNoticeKind = "forbidden" | "not-mergeable" | "unavailable";

export type MergeButtonProps = {
  readonly number: number;
  /** 送る先。**どこへ送るかを決めるのは、この部品の外**である。 */
  readonly action: string;
  /**
   * **いま盤面が見せている head の commit**（#331 のレビュー）。
   *
   * **これを送るので、押した対象と見せた対象が一致する**——**盤面を出してから
   * push された変更は、GitHub 側で食い違いとして弾かれる。**
   *
   * **分からないときは `undefined`。** **そのときは押せない**——
   * **確かめられない対象をマージさせない。**
   */
  readonly headSha: string | undefined;
  readonly disabled?: boolean;
};

/**
 * 押せなかった理由。**行き先が違うものを 1 つにまとめない。**
 *
 * **`forbidden` と `not-mergeable` を分ける。** **権限が足りないのか、
 * PR が整っていないのか**で、**押した人が次に取る行動が変わる**
 * （**権限を貰いに行く**のか、**PR を整えに行く**のか）。
 *
 * **GitHub の文面を載せない**（§6）。
 */
export function mergeNotice(kind: MergeNoticeKind): string {
  switch (kind) {
    case "forbidden":
      return "このリポジトリへ書き込む権限がないため、マージできません。";
    case "not-mergeable":
      // **理由を数え直さない**（#331）——**GitHub で見てもらう**
      return "いまはマージできません。コンフリクト・必須チェック・保護ルールを GitHub で確認してください。";
    case "unavailable":
      return "いまマージできませんでした。しばらくしてから試してください。";
  }
}

export function MergeButton({ number, action, headSha, disabled }: MergeButtonProps) {
  return (
    <form action={action} method="post">
      {/* **どの PR かを、送る本文が持つ** */}
      <input type="hidden" name="number" value={number} />
      {/* **どの commit を見せたか**も持つ——**押した対象を、見せた対象に固定する** */}
      {headSha === undefined ? undefined : <input type="hidden" name="sha" value={headSha} />}
      <button
        className="rounded border px-2 py-1 text-sm disabled:opacity-50"
        // **commit が分からなければ押せない**——**確かめられない対象をマージさせない**
        disabled={disabled === true || headSha === undefined}
        type="submit"
      >
        Merge
      </button>
    </form>
  );
}
