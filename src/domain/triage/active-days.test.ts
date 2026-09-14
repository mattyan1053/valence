/**
 * **最後に動いてから何日経ったか**（#716）。
 *
 * **利用者が挙げた 5 列のうち、材料が無かった 1 つ**である（#714）。
 * **`updatedAt` は #715 で 1 リポジトリの盤面まで通った**が、**日数はそこでは
 * 数えていない**——**数えるのはここ。**
 */

import { describe, expect, it } from "vitest";
import { activeDaysSince } from "./active-days";

const AT = new Date("2026-09-14T12:00:00Z");

describe("最後に動いてから何日か", () => {
  it("同じ時刻なら 0 日", () => {
    expect(activeDaysSince("2026-09-14T12:00:00Z", AT)).toBe(0);
  });

  it("丸一日に足りなければ 0 日", () => {
    // **切り上げない**——**「1 日前」と出すと、23 時間前に動いた PR と
    // 25 時間前に動いた PR が同じ顔になる。**
    expect(activeDaysSince("2026-09-13T12:00:01Z", AT)).toBe(0);
  });

  it("丸一日を超えたら 1 日", () => {
    expect(activeDaysSince("2026-09-13T12:00:00Z", AT)).toBe(1);
    expect(activeDaysSince("2026-09-12T13:00:00Z", AT)).toBe(1);
  });

  it("読めない時刻は「分からない」", () => {
    // **0 日へ倒さない**（§5）——**「今日動いた」と「読めなかった」は別**である。
    expect(activeDaysSince("unknown", AT)).toBeUndefined();
    expect(activeDaysSince("", AT)).toBeUndefined();
  });

  it("時刻が無ければ「分からない」", () => {
    // **読めなかった PR は地図に居ない**（#716）——**引けないことがそのまま来る。**
    expect(activeDaysSince(undefined, AT)).toBeUndefined();
  });

  it("盤面より新しい時刻でも、負の日数を出さない", () => {
    // **盤面は取りに行った時刻で止まっている**（#664）ので、**その後に動いた PR は
    // 未来に見える**——**「-1 日」は読む人の手に負えない。**
    expect(activeDaysSince("2026-09-14T12:00:01Z", AT)).toBe(0);
    expect(activeDaysSince("2026-09-20T00:00:00Z", AT)).toBe(0);
  });
});
