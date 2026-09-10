/**
 * **引き直す先を組む**（#664）。
 *
 * **「開いている側が引き直す」を選んだ**ので、**要るのは合図だけ**である
 * ——**盤面は要求ごとに描いている**（`page.tsx` の `force-dynamic`）ので、
 * **同じ道をもう一度開けば、その時点のものが出る。**
 *
 * **問い合わせだけを組む。** **道（パス）は書かない**——**行き先を渡さずに済み**、
 * **盤面の道が増えても、ここは変わらない。**
 */

/**
 * **いまの問い合わせを持ったまま、開き直す先。**
 *
 * **同じ鍵が 2 つ載っていたら、その鍵は持ち越さない**（配列で来る）
 * ——**どちらを選んでも、URL と画面が食い違う**（`ballFilterOf` と同じ判断）。
 *
 * **値をそのまま繋がない**（§6）——**問い合わせの値は、誰でも好きな文字列を
 * 入れられる。**
 */
export function boardReloadHref(
  query: Record<string, string | string[] | undefined>,
  /**
   * **持ち越さない鍵**（#664 のレビュー 2 周目）。
   *
   * **「さっき押した結果」の断りが載る鍵**である——**引き直しで持ち越すと、
   * 押していないのに同じ断りがもう一度出る。**
   *
   * **ここに並べない。** **断りを読む側（`boardNotices`）と同じ集合**なので、
   * **読む側の隣に置いて渡す**——**離すと、断りが 1 つ増えた日に片方だけが古くなる**
   * （**実際に `?plan=` で起きた**。`AGENTS.md` §5）。
   *
   * **既定を置かない。** **渡し忘れが「全部持ち越す」へ倒れると、この判定が
   * まるごと素通りする。**
   */
  outcomeKeys: readonly string[],
): string {
  const carried = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string" && !outcomeKeys.includes(key)) {
      carried.set(key, value);
    }
  }
  const rest = carried.toString();
  // **`?` だけでも開き直せる**——**空にすると、いまの URL をそのまま指してしまう**
  return rest === "" ? "?" : `?${rest}`;
}
