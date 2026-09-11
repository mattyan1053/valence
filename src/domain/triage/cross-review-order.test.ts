/**
 * **横断の一覧の並び**（#683）。
 *
 * **依存は跨がない**ので、**先に入れる PR という順序はここに無い**
 * ——**1 リポジトリの盤面が持つ「推奨レビュー順」に当たるものが作れない。**
 */

import { describe, expect, it } from "vitest";
import { crossReviewOrder } from "./cross-review-order";

const row = (owner: string, name: string, number: number, updatedAt: string) => ({
  repository: { owner, name },
  number,
  updatedAt,
});

describe("横断の一覧の並び", () => {
  it("最後に動いたものから並ぶ", () => {
    // **跨いで使える材料は、動いた時刻しか無い**（#683）——**依存も Tier も
    // 跨がない。** **止まっているものを下へ送るのではなく、動いたものを上へ出す**
    const ordered = crossReviewOrder([
      row("a", "one", 1, "2026-01-01T00:00:00Z"),
      row("b", "two", 2, "2026-03-01T00:00:00Z"),
      row("c", "three", 3, "2026-02-01T00:00:00Z"),
    ]);

    expect(ordered.map((one) => one.number)).toEqual([2, 3, 1]);
  });

  it("同じ時刻なら、いつも同じ順で出る", () => {
    // **並びが揺れると、2 回開いたときに同じ画面に見えない**——**読む人は
    // 「何か変わった」と読む。** **時刻が同じなら、置き場所と番号で決める**
    const same = "2026-01-01T00:00:00Z";
    const ordered = crossReviewOrder([
      row("b", "one", 2, same),
      row("a", "two", 9, same),
      row("a", "two", 3, same),
      row("a", "one", 5, same),
    ]);

    expect(
      ordered.map((one) => `${one.repository.owner}/${one.repository.name}#${one.number}`),
    ).toEqual(["a/one#5", "a/two#3", "a/two#9", "b/one#2"]);
  });

  it("渡されたものを書き換えない", () => {
    // **並べ替えは新しい並びを返す**——**呼ぶ側が持っているものを、黙って入れ替えない**
    const rows = [
      row("a", "one", 1, "2026-01-01T00:00:00Z"),
      row("b", "two", 2, "2026-03-01T00:00:00Z"),
    ];
    crossReviewOrder(rows);

    expect(rows.map((one) => one.number)).toEqual([1, 2]);
  });
});
