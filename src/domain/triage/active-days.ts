/**
 * **最後に動いてから何日経ったか**（#716）。
 *
 * **利用者が挙げた列の 1 つ**（#714）——**「active 日数」。**
 *
 * **時計は受け取る。** **盤面は「取りに行った時刻」で止まっている**（#664）ので、
 * **その時刻から数える**——**描くたびに今を読むと、同じ盤面が読むたびに違う日数を出す。**
 *
 * **「分からない」を 0 日へ倒さない**（`AGENTS.md` §5）——**「今日動いた」と
 * 「読めなかった」は別**である。
 */

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * **丸一日を数える**（切り捨て）。
 *
 * **切り上げない**——**23 時間前に動いた PR と 25 時間前に動いた PR が
 * 同じ顔になる**（**比べるための列**である）。
 *
 * **未来は 0 日**。**盤面より後に動いた PR は未来に見える**（**取りに行った時刻で
 * 止まっている**）——**負の日数は、読む人の手に負えない。**
 */
export function activeDaysSince(updatedAt: string | undefined, at: Date): number | undefined {
  if (updatedAt === undefined) {
    return undefined;
  }
  const moved = Date.parse(updatedAt);
  if (Number.isNaN(moved)) {
    return undefined;
  }
  return Math.max(0, Math.floor((at.getTime() - moved) / MILLIS_PER_DAY));
}
