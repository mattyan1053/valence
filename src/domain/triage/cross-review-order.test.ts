/**
 * **横断の一覧の並び**（#683）。
 *
 * **依存は跨がない**ので、**先に入れる PR という順序はここに無い**
 * ——**1 リポジトリの盤面が持つ「推奨レビュー順」に当たるものが作れない。**
 */

import { describe, expect, it } from "vitest";
import { crossReviewOrder } from "./cross-review-order";

const row = (owner: string, name: string, number: number, updatedAt?: string) => ({
  repository: { owner, name },
  number,
  updatedAt,
});

const OLD = "2026-01-01T00:00:00Z";
const NEW = "2026-03-01T00:00:00Z";

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

  it("時刻を読めなかった行は、下へ送る", () => {
    // **読めなかったものを「いま動いた」側へ倒さない**（#719）——**上へ出すと、
    // 動いていない PR がいちばん目に付く場所に並ぶ。**
    // **落とさない**（**行は残る**）ので、**下に置いて読む人が決める**
    // **渡す順を変えても同じ答えになること**まで見る——**大小の比較が
    // `undefined` を素通りさせると、答えが渡した順で変わる**（**推移律が壊れる**）
    const orders = [
      [row("a", "one", 1, undefined), row("b", "two", 2, OLD), row("c", "three", 3, NEW)],
      [row("b", "two", 2, OLD), row("c", "three", 3, NEW), row("a", "one", 1, undefined)],
      [row("c", "three", 3, NEW), row("a", "one", 1, undefined), row("b", "two", 2, OLD)],
    ];

    for (const rows of orders) {
      expect(
        crossReviewOrder(rows).map((one) => one.number),
        `渡す順が ${rows.map((one) => one.number).join(",")} のとき`,
      ).toEqual([3, 2, 1]);
    }
  });

  it("時刻を読めなかった行が、他の順序を巻き込まない", () => {
    // **形の違う 1 件が、他を並べ替えてはいけない**（#719 の完了条件）
    const withTime = [
      row("a", "one", 1, "2026-01-01T00:00:00Z"),
      row("b", "two", 2, "2026-03-01T00:00:00Z"),
      row("c", "three", 3, "2026-02-01T00:00:00Z"),
    ];
    const want = crossReviewOrder(withTime).map((one) => one.number);

    // **読めない 1 件を、どの位置へ挟んでも**——**他の並びは変わらない**
    for (let at = 0; at <= withTime.length; at += 1) {
      const rows = [...withTime];
      rows.splice(at, 0, row("x", "broken", 9, undefined));

      expect(
        crossReviewOrder(rows)
          .map((one) => one.number)
          .filter((number) => number !== 9),
        `${at} 番目に挟んだとき`,
      ).toEqual(want);
    }
  });

  it("時刻を読めなかった行どうしも、いつも同じ順で出る", () => {
    // **並びが揺れると、2 回開いたときに同じ画面に見えない**（上と同じ理由）
    const ordered = crossReviewOrder([
      row("b", "one", 2, undefined),
      row("a", "two", 9, undefined),
      row("a", "one", 5, undefined),
    ]);

    expect(
      ordered.map((one) => `${one.repository.owner}/${one.repository.name}#${one.number}`),
    ).toEqual(["a/one#5", "a/two#9", "b/one#2"]);
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
