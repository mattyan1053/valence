/**
 * **画面からログアウトする**（#563）。
 *
 * **表示に専念する**（`AGENTS.md` §3）。**送る先は props で受ける**ので、
 * **この部品は application も composition も知らない**（`ui-has-no-io`）。
 *
 * **POST で出す。** **`/auth/logout` は POST だけを受ける**——**GET で消せると
 * `<img src>` 1 つで他人をログアウトさせられる**（`src/app/auth/logout/route.ts`）。
 * **押しやすくするためにリンクへ替えない**——**替えた瞬間に、その口の作りが無意味になる。**
 */

/** 送る先と、誰から出るのか。**経路を組むのは `app` の話である。** */
export type SignOutButtonProps = {
  /** 送る先。**どこへ送るかを決めるのは、この部品の外**である。 */
  readonly action: string;
  /**
   * **いま入っている人**。**分からなければ渡さない**——**出るときに
   * 「誰から出るのか」が見えるとよい**が、**空の名前を誰かとして出さない。**
   */
  readonly signedInAs?: string;
};

/**
 * **その画面でログアウトを出すか**（#563）。
 *
 * **判定をここ 1 箇所に置く**（§5）——**入口の画面と盤面の両方から呼ぶ**ので、
 * **書き写すと片方だけが直る。**
 *
 * **語は呼ぶ側の結果（`result.kind`）をそのまま渡す**（`listed` / `board` /
 * `needs-login` / `signed-out` / `unavailable`）——**型では受けない**
 * （**`ui` は `application` を import できない**）。
 *
 * **知らない語は「出す」へ倒す。** **出して困るのは、押しても消すものが無い 1 回**
 * だけだが、**出し損ねると、詰まった人に打つ手が無い**——**それがこの Issue である。**
 */
export function showsSignOut(kind: string): boolean {
  // **畳むセッションが無い側だけを外す。**
  // - `signed-out` … 置き場が開かなかったのではなく、**そもそも入っていない**
  // - `unavailable` … **入り直しても直らない故障**（#213 のレビューで分けた語）。
  //   **ここで出すと、故障を認証切れとして案内することになる**
  return kind !== "signed-out" && kind !== "unavailable";
}

export function SignOutButton({ action, signedInAs }: SignOutButtonProps) {
  return (
    <form action={action} className="flex items-center gap-2 text-sm" method="post">
      {signedInAs === undefined ? undefined : <span className="opacity-70">{signedInAs} さん</span>}
      <button className="rounded border px-2 py-1 text-sm" type="submit">
        ログアウト
      </button>
    </form>
  );
}
