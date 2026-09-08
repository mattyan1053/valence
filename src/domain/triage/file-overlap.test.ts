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
});
