/**
 * **そのユーザーが、そのリポジトリに対して持っている権限の高さ**（#317 のレビュー）。
 *
 * **「見える」と「書ける」は別である。** **`VisibleRepositories` が答えるのは前者だけ**
 * ——**read-only の collaborator / org member も、見えるものとしては返ってくる。**
 *
 * **これを確かめずに書き込むと、権限が上がる。** **App は `pull_requests: write` を
 * 持っている**ので、**その人が自分で出しても保護ルールに数えられない承認が、
 * App 経由だと数えられる**——**代理ではなく、権限の格上げ**である。
 *
 * **ユーザートークンで引く**（`AGENTS.md` §6）。**installation トークンで代用すると、
 * 「誰がログインしていても同じ答え」になり、この口の意味が消える。**
 */

import type { VisibleRepository } from "./visible-repositories";

/**
 * 権限の高さ。**GitHub の言葉ではなく、こちらの語彙で持つ**（§3）。
 *
 * **`triage` / `maintain` を並べない。** **こちらが要るのは「書けるか」だけ**なので、
 * **書ける側を並べ、それ以外は下へ倒す**（#90 と同じ判断——**知らない値が
 * どの分岐にも入らない形にしない**）。
 */
export type RepositoryAccessLevel = "admin" | "write" | "read" | "none";

export type RepositoryPermissions = {
  /**
   * そのユーザーの権限の高さを返す。
   *
   * **取得に失敗したら投げる。** **`none` を返すと「権限が無い」と区別できず、
   * 判定不能が「拒否」に化ける**——**倒す向きとしては安全側だが、
   * 押した人には「権限がありません」と嘘を伝えることになる。**
   */
  levelFor(userAccessToken: string, repository: VisibleRepository): Promise<RepositoryAccessLevel>;
};
