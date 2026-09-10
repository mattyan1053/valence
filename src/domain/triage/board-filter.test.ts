import { describe, expect, it } from "vitest";
import type { Ball } from "./ball";
import { filterByBall } from "./board-filter";

function row(number: number, ball: Ball) {
  return { number, ball };
}

describe("盤面の一覧を、誰の番かで絞る", () => {
  it("その番のものだけを通す", () => {
    const outcome = filterByBall(
      [row(1, "author"), row(2, "reviewer"), row(3, "author")],
      "author",
    );

    expect(outcome.shown).toEqual([1, 3]);
  });

  it("落とした件数を出す", () => {
    // **「絞って 0 件」と「1 件も無い」を言い分けるための数**である（#410 と同じ形）
    const outcome = filterByBall([row(1, "author"), row(2, "reviewer")], "author");

    expect(outcome.hidden).toBe(1);
  });

  it("絞らないときは全部通す", () => {
    // **既定は絞らない**——**開いた瞬間に一部しか見えていないと、
    // 見えていないことに気づけない**（#663）
    const outcome = filterByBall([row(1, "author"), row(2, "reviewer")], undefined);

    expect(outcome.shown).toEqual([1, 2]);
    expect(outcome.hidden, "絞っていないのに隠したと言っている").toBe(0);
  });

  it("全部落ちても、落ちた件数は残る", () => {
    // **0 件になったときに黙らない**（#663 の「気をつけること」）
    const outcome = filterByBall([row(1, "reviewer"), row(2, "nobody")], "author");

    expect(outcome.shown).toEqual([]);
    expect(outcome.hidden).toBe(2);
  });

  it("渡された順のまま返す", () => {
    // **並びはここで決めない**——**依存の順は `order` が持つ**（`review-board.tsx`）
    const outcome = filterByBall([row(9, "author"), row(3, "author"), row(5, "author")], "author");

    expect(outcome.shown).toEqual([9, 3, 5]);
  });

  it("「分からない」でも絞れる", () => {
    // **`unknown` は「読めなかった」と「規則に当たらない」が入る**（`ballOf`）
    // ——**絞る口としては、他と同じに扱う**（**画面が出すかどうかは画面が決める**）
    const outcome = filterByBall([row(1, "unknown"), row(2, "author")], "unknown");

    expect(outcome.shown).toEqual([1]);
  });
});
