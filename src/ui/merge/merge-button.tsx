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
export type MergeNoticeKind =
  | "forbidden"
  | "not-mergeable"
  | "dependency-pending"
  | "base-changed"
  | "not-orderable"
  | "unavailable";

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
  /**
   * **先に入れる PR の番号**（#345）。
   *
   * **依存が残っているなら押させない。** **空でなければ、その番号を出す**
   * ——**「押せない」だけでは、何をすればよいか分からない。**
   *
   * **これは表示側の閉じ方である。** **POST の口でも同じことを見る**
   * （**画面を経由しない要求が作れる**）。
   */
  readonly blockedBy?: readonly number[];
  /**
   * **順序を判定できない**（#345 / #348）。**先に入れるものを名指しできない。**
   *
   * **循環・一覧に無い番号・読めなかった PR がある**のどれでも立つ——
   * **原因は言い分けない**（**言い分けるには理由を運ぶ必要がある**）。
   */
  readonly notOrderable?: boolean;
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
    case "dependency-pending":
      // **土台を先に入れる**（#345）——**上段を先に入れると、土台のブランチに
      // 未確認の変更が混ざる**
      return "土台の PR が残っています。先にそちらをマージしてください。";
    case "base-changed":
      // **押した人が次にすることは「盤面を見直してもう一度押す」**（#350）
      // ——**`not-mergeable`（コンフリクト等）とも `not-orderable`（順序）とも違う。**
      return "この PR の土台が変わりました。盤面を読み込み直してから、もう一度押してください。";
    case "not-orderable":
      // **原因を言い分けない**（#348 のレビュー）——**循環・一覧に無い番号・
      // 読めなかった PR のどれでもここへ来る。** **「循環しています」と断定すると、
      // 循環していない場合に嘘の理由が伝わる**（**名前を `not-orderable` にした
      // 理由がこれで、文面だけ古いままだった**）。
      return "依存の順序を判定できませんでした。GitHub で確認してください。";
    case "unavailable":
      return "いまマージできませんでした。しばらくしてから試してください。";
  }
}

export function MergeButton({
  number,
  action,
  headSha,
  blockedBy,
  notOrderable,
  disabled,
}: MergeButtonProps) {
  const waiting = blockedBy !== undefined && blockedBy.length > 0;
  return (
    <form action={action} method="post">
      {/* **どの PR かを、送る本文が持つ** */}
      <input type="hidden" name="number" value={number} />
      {/* **どの commit を見せたか**も持つ——**押した対象を、見せた対象に固定する** */}
      {headSha === undefined ? undefined : <input type="hidden" name="sha" value={headSha} />}
      <button
        className="rounded border px-2 py-1 text-sm disabled:opacity-50"
        // **commit が分からなければ押せない**——**確かめられない対象をマージさせない**
        // **依存が残っていても押せない**（#345）
        disabled={disabled === true || headSha === undefined || waiting || notOrderable === true}
        type="submit"
      >
        Merge
      </button>
      {/* **何を先に入れればよいかを出す**——**「押せない」だけにしない** */}
      {waiting ? (
        <span className="text-sm opacity-70">
          先に {blockedBy.map((blocker) => `#${blocker}`).join(", ")} をマージ
        </span>
      ) : undefined}
      {notOrderable === true ? (
        <span className="text-sm opacity-70">依存の順序を判定できません</span>
      ) : undefined}
    </form>
  );
}
