import { describe, expect, it } from "vitest";
import type { OverlapCandidate } from "./file-overlap";
import { fileOverlapsFor } from "./file-overlap";

function candidate(number: number, paths: readonly string[], truncated = false): OverlapCandidate {
  return { number, changedPaths: { paths, truncated } };
}

/** 材料そのものが取れていない PR。**「触っていない」ではない。** */
function unmeasured(number: number): OverlapCandidate {
  return { number, changedPaths: undefined };
}

describe("同じファイルを触る PR を並べる", () => {
  it("重なっている PR と、その数を出す", () => {
    const reports = fileOverlapsFor([
      candidate(1, ["a.ts", "b.ts"]),
      candidate(2, ["b.ts", "c.ts"]),
    ]);

    expect(reports.get(1)?.overlaps).toEqual([{ number: 2, count: 1 }]);
  });

  it("重なっていなければ、何も出ない", () => {
    const reports = fileOverlapsFor([candidate(1, ["a.ts"]), candidate(2, ["b.ts"])]);

    expect(reports.get(1)?.overlaps).toEqual([]);
  });

  it("多く重なっている相手から並べる", () => {
    // **どれを先に見るかを決める材料**である——**並びが揺れると、理由が読めない**
    const reports = fileOverlapsFor([
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
    const reports = fileOverlapsFor([
      candidate(1, ["a.ts"]),
      candidate(3, ["a.ts"]),
      candidate(2, ["a.ts"]),
    ]);

    expect(reports.get(1)?.overlaps.map((overlap) => overlap.number)).toEqual([2, 3]);
  });

  it("自分自身とは重ねない", () => {
    const reports = fileOverlapsFor([candidate(1, ["a.ts"])]);

    expect(reports.get(1)?.overlaps).toEqual([]);
  });

  it("見切れた一覧で測った数は、下限だと言う", () => {
    // **「測れなかった」を「重なっていない」にしない**（#637）
    const reports = fileOverlapsFor([candidate(1, ["a.ts"], true), candidate(2, ["a.ts", "b.ts"])]);

    expect(reports.get(1)?.partial, "自分の一覧が見切れている").toBe(true);
  });

  it("相手の一覧が見切れていても、下限だと言う", () => {
    // **見えていないパスが重なっているかもしれない**——**相手側でも同じ**
    const reports = fileOverlapsFor([candidate(1, ["a.ts"]), candidate(2, ["b.ts"], true)]);

    expect(reports.get(1)?.partial, "相手の一覧が見切れている").toBe(true);
    expect(reports.get(1)?.overlaps, "見えた範囲では重なっていない").toEqual([]);
  });

  it("どの一覧も見切れていなければ、下限だとは言わない", () => {
    // **上の 2 つが空でないことを、ここが支えている**
    const reports = fileOverlapsFor([candidate(1, ["a.ts"]), candidate(2, ["a.ts"])]);

    expect(reports.get(1)?.partial).toBe(false);
  });

  it("材料が取れていない PR が居れば、下限だと言う", () => {
    // **その PR が何を触ったか分からない**——**見えていないだけで、重なっているかも
    // しれない。** **見切れているのと同じ扱い**である
    const reports = fileOverlapsFor([candidate(1, ["a.ts"]), unmeasured(2)]);

    expect(reports.get(1)?.partial, "測れていない PR が居るのに下限と言っていない").toBe(true);
  });

  it("材料が取れていない PR も、行としては返る", () => {
    // **黙って落とさない**
    const reports = fileOverlapsFor([candidate(1, ["a.ts"]), unmeasured(2)]);

    expect(reports.get(2)?.overlaps).toEqual([]);
  });

  it("訊いた PR は、重なりが無くても全部返る", () => {
    // **黙って落とさない**——**行が消えると、測ったのかどうかが分からない**
    const reports = fileOverlapsFor([candidate(1, ["a.ts"]), candidate(2, ["b.ts"])]);

    expect([...reports.keys()].sort()).toEqual([1, 2]);
  });

  it("同じファイルを 2 本が触っていれば、どちらの行にも出る", () => {
    const reports = fileOverlapsFor([candidate(8, ["a.ts"]), candidate(9, ["a.ts"])]);

    expect(reports.get(8)?.overlaps).toEqual([{ number: 9, count: 1 }]);
    expect(reports.get(9)?.overlaps).toEqual([{ number: 8, count: 1 }]);
  });

  it("本数が増えても、2 乗にならない", () => {
    // **盤面は全部の行について呼ぶ**（`mergeBlocksFor` と同じ理由）
    const many = Array.from({ length: 400 }, (_, index) =>
      candidate(index + 1, [`file-${index}.ts`]),
    );

    const started = process.hrtime.bigint();
    fileOverlapsFor(many);
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;

    expect(elapsed, `400 本で ${elapsed} ms`).toBeLessThan(500);
  });
});
