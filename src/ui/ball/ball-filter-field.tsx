/**
 * **いま選んでいる絞りを、押す本文に載せる**（#667）。
 *
 * **盤面の操作は POST → 303 → 盤面**である。**戻り先は口が組み立てる**ので、
 * **絞りを本文で運ばないと、押すたびに「すべて」へ戻る**——**件数を減らした意味が、
 * 押した瞬間に消える。**
 *
 * **部品にしたのは、盤面のフォームが 3 つあるから**である（Approve / Merge /
 * マージ順に流す）——**鍵の名前（`ball`）を 3 箇所に散らさない。**
 * **受ける側の名前は `submittedBallFilter` が持つ**（**境界をまたぐので、
 * 1 つにはできない**）。
 *
 * **絞っていなければ、何も出さない**——**空の鍵を付けて回らない。**
 */

import type { BallFilter } from "./ball-filter";

export function BallFilterField({ ball }: { readonly ball?: BallFilter }) {
  return ball === undefined ? null : <input name="ball" type="hidden" value={ball} />;
}
