import { describe, expect, it } from "vitest";
import type { OverlapCandidate } from "./file-overlap";
import { fileOverlapsFor } from "./file-overlap";

/** **読めなかった PR は 0 件**。**既定値は置かない**ので、毎回渡す。 */
const NOTHING_UNREADABLE = 0;

function candidate(number: number, paths: readonly string[], truncated = false): OverlapCandidate {
  return { number, changedPaths: { paths, truncated } };
}

/** 材料そのものが取れていない PR。**「触っていない」ではない。** */
function unmeasured(number: number): OverlapCandidate {
  return { number, changedPaths: undefined };
}

describe("同じファイルを触る PR を並べる", () => {
  it("重なっている PR と、その数を出す", () => {
    const reports = fileOverlapsFor(NOTHING_UNREADABLE, [
      candidate(1, ["a.ts", "b.ts"]),
      candidate(2, ["b.ts", "c.ts"]),
    ]);

    expect(reports.get(1)?.overlaps).toEqual([{ number: 2, count: 1 }]);
  });

  it("重なっていなければ、何も出ない", () => {
    const reports = fileOverlapsFor(NOTHING_UNREADABLE, [
      candidate(1, ["a.ts"]),
      candidate(2, ["b.ts"]),
    ]);

    expect(reports.get(1)?.overlaps).toEqual([]);
  });

  it("多く重なっている相手から並べる", () => {
    // **どれを先に見るかを決める材料**である——**並びが揺れると、理由が読めない**
    const reports = fileOverlapsFor(NOTHING_UNREADABLE, [
      candidate(1, ["a.ts", "b.ts", "c.ts"]),
      candidate(2, ["c.ts"]),
      candidate(3, ["a.ts", "b.ts"]),
    ]);

    expect(reports.get(1)?.overlaps).toEqual([
      { number: 3, count: 2 },
      { number: 2, count: 1 },
    ]);
  });

  it("同じ数なら、番号の小さい順に並べる", () => {
    const reports = fileOverlapsFor(NOTHING_UNREADABLE, [
      candidate(1, ["a.ts"]),
      candidate(3, ["a.ts"]),
      candidate(2, ["a.ts"]),
    ]);

    expect(reports.get(1)?.overlaps.map((overlap) => overlap.number)).toEqual([2, 3]);
  });

  it("同じパスが 2 回あっても、1 個として数える", () => {
    // **`ChangedPaths.paths` は一意ではない**（#651 のレビュー）——
    // **`toChangeSummary` は `filename` と `previous_filename` を並べる**ので、
    // **`a.ts → b.ts` に移して新しい `a.ts` を足した PR** は `["a.ts", "b.ts", "a.ts"]`
    const reports = fileOverlapsFor(NOTHING_UNREADABLE, [
      candidate(1, ["a.ts", "b.ts", "a.ts"]),
      candidate(2, ["a.ts"]),
    ]);

    expect(reports.get(1)?.overlaps).toEqual([{ number: 2, count: 1 }]);
  });

  it("相手のパスが 2 回あっても、1 個として数える", () => {
    // **`A → B` と `B → C` を 1 本でやると `[B, A, C, B]`**——
    // **ディレクトリを整理する PR でふつうに起きる**
    const reports = fileOverlapsFor(NOTHING_UNREADABLE, [
      candidate(1, ["a.ts"]),
      candidate(2, ["a.ts", "a.ts"]),
    ]);

    expect(reports.get(1)?.overlaps).toEqual([{ number: 2, count: 1 }]);
  });

  it("重複が並びを変えない", () => {
    // **水増しされると、多い順の並びまで変わる**
    const reports = fileOverlapsFor(NOTHING_UNREADABLE, [
      candidate(1, ["a.ts", "b.ts", "c.ts"]),
      candidate(2, ["a.ts", "a.ts", "a.ts"]),
      candidate(3, ["b.ts", "c.ts"]),
    ]);

    expect(reports.get(1)?.overlaps.map((overlap) => overlap.number)).toEqual([3, 2]);
  });

  it("自分自身とは重ねない", () => {
    const reports = fileOverlapsFor(NOTHING_UNREADABLE, [candidate(1, ["a.ts"])]);

    expect(reports.get(1)?.overlaps).toEqual([]);
  });

  it("見切れた一覧で測った数は、下限だと言う", () => {
    // **「測れなかった」を「重なっていない」にしない**（#637）
    const reports = fileOverlapsFor(NOTHING_UNREADABLE, [
      candidate(1, ["a.ts"], true),
      candidate(2, ["a.ts", "b.ts"]),
    ]);

    expect(reports.get(1)?.partial, "自分の一覧が見切れている").toBe(true);
  });

  it("相手の一覧が見切れていても、下限だと言う", () => {
    // **見えていないパスが重なっているかもしれない**——**相手側でも同じ**
    const reports = fileOverlapsFor(NOTHING_UNREADABLE, [
      candidate(1, ["a.ts"]),
      candidate(2, ["b.ts"], true),
    ]);

    expect(reports.get(1)?.partial, "相手の一覧が見切れている").toBe(true);
    expect(reports.get(1)?.overlaps, "見えた範囲では重なっていない").toEqual([]);
  });

  it("どの一覧も見切れていなければ、下限だとは言わない", () => {
    // **上の 2 つが空でないことを、ここが支えている**
    const reports = fileOverlapsFor(NOTHING_UNREADABLE, [
      candidate(1, ["a.ts"]),
      candidate(2, ["a.ts"]),
    ]);

    expect(reports.get(1)?.partial).toBe(false);
  });

  it("読めなかった PR が居れば、重なりがゼロでも下限だと言う", () => {
    // **検証に落ちた PR は番号が読めない**ので、候補にできない（#651 のレビュー 3 周目）
    // ——**それでも同じファイルを触っているかもしれない。**
    // **盤面は既に「N 件の PR は読めませんでした」と出している**——
    // **その画面で、重なりだけが「抜けは無い」と言うことになる**
    const reports = fileOverlapsFor(1, [candidate(1, ["a.ts"]), candidate(2, ["b.ts"])]);

    expect(reports.get(1)?.overlaps, "見えた範囲では重なっていない").toEqual([]);
    expect(reports.get(1)?.partial, "読めなかった PR が居るのに下限と言っていない").toBe(true);
  });

  it("材料が取れていない PR が居れば、下限だと言う", () => {
    // **その PR が何を触ったか分からない**——**見えていないだけで、重なっているかも
    // しれない。** **見切れているのと同じ扱い**である
    const reports = fileOverlapsFor(NOTHING_UNREADABLE, [candidate(1, ["a.ts"]), unmeasured(2)]);

    expect(reports.get(1)?.partial, "測れていない PR が居るのに下限と言っていない").toBe(true);
  });

  it("材料が取れていない PR も、行としては返る", () => {
    // **黙って落とさない**
    const reports = fileOverlapsFor(NOTHING_UNREADABLE, [candidate(1, ["a.ts"]), unmeasured(2)]);

    expect(reports.get(2)?.overlaps).toEqual([]);
  });

  it("訊いた PR は、重なりが無くても全部返る", () => {
    // **黙って落とさない**——**行が消えると、測ったのかどうかが分からない**
    const reports = fileOverlapsFor(NOTHING_UNREADABLE, [
      candidate(1, ["a.ts"]),
      candidate(2, ["b.ts"]),
    ]);

    expect([...reports.keys()].sort()).toEqual([1, 2]);
  });

  it("同じファイルを 2 本が触っていれば、どちらの行にも出る", () => {
    const reports = fileOverlapsFor(NOTHING_UNREADABLE, [
      candidate(8, ["a.ts"]),
      candidate(9, ["a.ts"]),
    ]);

    expect(reports.get(8)?.overlaps).toEqual([{ number: 9, count: 1 }]);
    expect(reports.get(9)?.overlaps).toEqual([{ number: 8, count: 1 }]);
  });

  it("全部が同じファイルを触っていても、組が消えない", () => {
    // **組の数は「共有しているパスに何本が乗っているか」で決まる**（#651 のレビュー）
    // ——**`pnpm-lock.yaml` を全 PR が触れば、本数の 2 乗**である。
    // **前の版は候補ごとに違うパスを与えていて、この経路を通っていなかった。**
    //
    // **「遅い」を結論にしない**——**数を出すところまで**（この PR の主題と同じ形）。
    // **上限は入れていない**ので、**ここで見るのは「組が消えていないこと」**である。
    const many = Array.from({ length: 400 }, (_, index) =>
      candidate(index + 1, ["pnpm-lock.yaml", `file-${index}.ts`]),
    );

    const started = process.hrtime.bigint();
    const reports = fileOverlapsFor(NOTHING_UNREADABLE, many);
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;

    // **1 本が残り 399 本と重なる**
    expect(reports.get(1)?.overlaps, `400 本で ${elapsed} ms`).toHaveLength(399);
  });
  it("組が多すぎるときは区切って、下限だと言う", () => {
    // **上限を入れた**（#656。**測ってから決めた**）——**素のままだと
    // 「共有パスに乗った本数の 2 乗」**で、**全部が同じ 20 パスを触る 1000 本で
    // 4.7 秒**、**2000 本で 18.4 秒**だった（**このコンテナで実測**）。
    // **盤面が開かないのは、行が 1 つ黙るのとは違う。**
    //
    // **見るのは時間ではなく「返ってくること」と「`partial` が立つこと」**である
    // （#653 が同じ向きで決めた。**時間で赤くする根拠は、上限を決めてからしか無い**）。
    // **250 本 × 20 パスで 1,245,000 組**——**上限の 1,000,000 を超える。**
    const shared = Array.from({ length: 20 }, (_, index) => `shared-${index}.ts`);
    const many = Array.from({ length: 250 }, (_, index) => candidate(index + 1, shared));

    const started = process.hrtime.bigint();
    const reports = fileOverlapsFor(NOTHING_UNREADABLE, many);
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;

    expect(reports.size, `250 本で ${elapsed} ms`).toBe(250);
    expect(reports.get(1)?.partial, "区切ったのに下限だと言っていない").toBe(true);
  });

  it("実物と同じ形の 100 本では、区切らない", () => {
    // **上限を低く置きすぎると、ふつうの盤面が毎回「下限です」になる**
    // ——**そちらの向きも測る**（#656 の完了条件）。
    // **このリポジトリの PR 100 本を数えた**: **触ったパスは 1 本あたり中央 4 個・
    // 最大 21 個**、**組は合計 1890**（**同じ形なら 1000 本でも 189,000 で、
    // 上限に届かない**）。
    const many = Array.from({ length: 100 }, (_, index) =>
      candidate(index + 1, [
        `src/feature-${index % 25}/one.ts`,
        `src/feature-${index % 25}/two.ts`,
        `src/feature-${index % 25}/three.ts`,
        `src/only-${index}.ts`,
      ]),
    );

    const reports = fileOverlapsFor(NOTHING_UNREADABLE, many);

    expect(reports.get(1)?.overlaps, "実物の形なのに組が消えている").toHaveLength(3);
    expect(reports.get(1)?.partial, "測り切れているのに下限と言っている").toBe(false);
  });
  /**
   * **予算をちょうど使い切る盤面**（#660 のレビュー）。
   *
   * **1 本のパスを n 本が共有すると n × (n − 1) 組**である。
   * **1000 本で 999,000 組**——**あと 1,000 組足して、上限ちょうどにする**
   * （**25 本で 600 / 20 本で 380 / 5 本で 20**）。
   *
   * **最後に見るのは、いちばん大きい番号の行の、自分自身**である
   * ——**索引の並びは番号順**なので、**自分自身が末尾に来る。**
   */
  function onBudget(overshoot: boolean): OverlapCandidate[] {
    const paths = Array.from({ length: 1000 }, () => ["shared.ts"]);
    for (const [path, count] of [
      ["r.ts", 25],
      ["s.ts", 20],
      ["t.ts", 5],
    ] as const) {
      for (let index = 0; index < count; index += 1) {
        (paths[index] as string[]).push(path);
      }
    }
    if (overshoot) {
      // **1 組だけ増やす**——**予算は自分自身へ届く前に尽きる**
      (paths[0] as string[]).push("u.ts");
      paths.push(["u.ts"]);
    }
    return paths.map((own, index) => candidate(index + 1, own));
  }

  it("上限ちょうどで、残りが自分自身だけなら、下限だとは言わない", () => {
    // **自分自身は予算を使わない**（#660 のレビュー）——**使わないものを数える前に
    // 予算を見ると、1 件も落としていないのに全行が「下限です」になる。**
    const reports = fileOverlapsFor(NOTHING_UNREADABLE, onBudget(false));

    expect(reports.get(1000)?.overlaps, "最後の行が数え切れていない").toHaveLength(999);
    expect(reports.get(1)?.partial, "全部数えたのに下限だと言っている").toBe(false);
  });

  it("上限ちょうどで、まだ相手が残っているなら、下限だと言う", () => {
    // **境界の反対側**（#660 のレビュー）——**1 組だけ増やすと、予算は自分自身へ
    // 届く前に尽きる。** **こちらは区切っているので、下限で正しい。**
    const reports = fileOverlapsFor(NOTHING_UNREADABLE, onBudget(true));

    expect(reports.get(1)?.partial, "区切ったのに下限だと言っていない").toBe(true);
  });
});
