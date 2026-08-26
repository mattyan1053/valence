/**
 * **押せなかった理由を、サーバ側に 1 行だけ残す** (#506 の 2。#248 と同じ形)。
 *
 * **画面には出せない。** **`?approve=unavailable` は 4 つの理由をまとめた語**である
 * ——**`signed-out` / `needs-login` / `not-found` / `unavailable` を分けて出すと、
 * 見えないリポジトリの存在を教える**（`AGENTS.md` §6）。**分けないのは正しい。**
 *
 * **問題は、どこにも残らないこと**だった——**利用者が「押せない」と言っても、
 * 4 つのどれかが分からない**（**2026-08-26 に実際に踏んだ。#506**）。
 *
 * **残すのは、こちら側の語彙だけ**である（`kind`）。**例外も本文もトークンも
 * 通さない**——**この口は `kind` しか受け取らない形にしてある。**
 *
 * **書き出す口を引数で受ける** (#248 と同じ)——**試験が、本物の標準エラーを
 * 汚さずに「出していないこと」を見られる。**
 */

/**
 * 押した操作。**画面の語彙と揃える**（`?approve=` / `?merge=`）。
 *
 * **`view` は「盤面を見に来た」** (#513 のレビュー)——**押していないが、
 * 落ちどころが消えるのは同じ**である（**GET の経路にも `unavailable` がある**）。
 */
export type BoardAction = "approve" | "merge" | "view";

/**
 * 押せなかった理由を 1 行残す。
 *
 * **押せたときは呼ばれない。** **毎回鳴る記録は、そのうち読まれなくなる**（#248）。
 */
export function reportBoardActionUnavailable(
  action: BoardAction,
  kind: string,
  write: (line: string) => void = console.error,
): void {
  write(`[board] ${action} unavailable kind=${kind}`);
}
