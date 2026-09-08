import { describe, expect, it } from "vitest";
import type { DependencyOrder } from "../graph/dependency-order";
import type { MergeReadiness } from "../graph/merge-readiness";
import type { ReviewCandidate } from "./review-priority";
import { suggestReviewOrder } from "./review-priority";
import type { ChangeSummary } from "./risk-tier";

const NO_DEPENDENCY: DependencyOrder = { ordered: [], cyclic: [] };

function change(overrides: Partial<ChangeSummary> = {}): ChangeSummary {
  return {
    changedFileCount: 1,
    changedLineCount: 5,
    changedPaths: { paths: ["src/ui/button.tsx"], truncated: false },
    ciStatus: "passing",
    ...overrides,
  };
}

/** **大きく、影響の大きいパスに触れる**——`classifyRiskTier` が `high-risk` を返す形。 */
const RISKY: ChangeSummary = change({
  changedPaths: { paths: ["src/infrastructure/github/app-jwt.ts"], truncated: false },
});

/** **いつもどおり読む大きさ**——`fast-track` の閾値は超えている。 */
const ORDINARY: ChangeSummary = change({ changedFileCount: 6, changedLineCount: 200 });

const MERGEABLE: MergeReadiness = { kind: "mergeable" };

function candidate(number: number, overrides: Partial<ReviewCandidate> = {}): ReviewCandidate {
  return { number, change: change(), readiness: MERGEABLE, ...overrides };
}

function numbersOf(candidates: readonly ReviewCandidate[], order = NO_DEPENDENCY) {
  return suggestReviewOrder(candidates, order).map((row) => row.number);
}

describe("どれから見るかを、理由つきで出す", () => {
  it("時間が要るものから先に見る", () => {
    // **`high-risk` の札は「先に人が見る」**である（`TIER_TEXT`）——**その札と、
    // 出す順が食い違っていると、どちらを信じてよいか分からない**
    const rows = suggestReviewOrder([candidate(1), candidate(2, { change: RISKY })], NO_DEPENDENCY);

    expect(rows.map((row) => row.number)).toEqual([2, 1]);
    expect(rows[0]?.reason).toBe("high-risk");
  });

  it("すぐ通せるものは、いつもどおり読むものより後になる", () => {
    // **短いから先、ではない**——**読む時間が要るものを先に始めたほうが、
    // 待っている人が早く進める**
    expect(numbersOf([candidate(1), candidate(2, { change: ORDINARY })])).toEqual([2, 1]);
  });

  it("著者の手が要るものは、後ろへ回す", () => {
    // **conflict している PR を「先に見ろ」と言わない**（#632 の完了条件）
    const rows = suggestReviewOrder(
      [candidate(1, { readiness: { kind: "conflicting" } }), candidate(2)],
      NO_DEPENDENCY,
    );

    expect(rows.map((row) => row.number)).toEqual([2, 1]);
    expect(rows[1]?.reason).toBe("needs-author");
  });

  it("下書きも、著者の手が要る側へ回す", () => {
    expect(numbersOf([candidate(1, { readiness: { kind: "draft" } }), candidate(2)])).toEqual([
      2, 1,
    ]);
  });

  it("CI が落ちているものも、著者の手が要る側へ回す", () => {
    // **`classifyRiskTier` は CI が落ちていると `high-risk` を返す**
    // ——**そのまま並べると、直っていないものが先頭に来る**
    const rows = suggestReviewOrder(
      [candidate(1, { change: change({ ciStatus: "failing" }) }), candidate(2)],
      NO_DEPENDENCY,
    );

    expect(rows.map((row) => row.number)).toEqual([2, 1]);
    expect(rows[1]?.reason).toBe("needs-author");
  });

  it("保護ルールで止まっているものは、後ろへ回さない", () => {
    // **未解決スレッドや承認の不足で止まっている**——**レビュアーを待っている側**である
    const rows = suggestReviewOrder(
      [candidate(1, { readiness: { kind: "blocked" }, change: RISKY }), candidate(2)],
      NO_DEPENDENCY,
    );

    expect(rows.map((row) => row.number)).toEqual([1, 2]);
  });

  it("材料が無いものは、理由つきで最後の手前に置く", () => {
    // **黙って落とさない**——**行が消えると、見落としたことに気づけない**
    const rows = suggestReviewOrder(
      [
        candidate(1, { change: undefined }),
        candidate(2, { readiness: { kind: "conflicting" } }),
        candidate(3),
      ],
      NO_DEPENDENCY,
    );

    expect(rows.map((row) => row.number)).toEqual([3, 1, 2]);
    expect(rows[1]?.reason).toBe("unknown");
  });

  it("1 件も落とさない", () => {
    // **並べ替えであって、絞り込みではない**
    const candidates = [candidate(1), candidate(2, { change: undefined }), candidate(3)];

    expect(suggestReviewOrder(candidates, NO_DEPENDENCY)).toHaveLength(3);
  });

  it("同じ理由なら、依存の順のまま", () => {
    // **土台を先に見たほうが、上に積まれたものが早く進む**——**ただし、これは
    // 並びを決める最後の手掛かり**であって、**マージ順そのものではない**
    const rows = numbersOf([candidate(9), candidate(8)], { ordered: [8, 9], cyclic: [] });

    expect(rows).toEqual([8, 9]);
  });

  it("依存の順に出てこないものは、その後ろに置く", () => {
    // **循環に居るものや、順序に出てこないもの**——**落とさずに後ろへ**
    const rows = numbersOf([candidate(7), candidate(8)], { ordered: [8], cyclic: [7] });

    expect(rows).toEqual([8, 7]);
  });

  it("依存の順は、理由より先に効かない", () => {
    // **依存の順で並べ替えない**（`review-board.tsx` の判断）——**混ぜると、
    // 土台より先に積み荷をマージしようとする**
    const rows = numbersOf([candidate(8), candidate(9, { change: RISKY })], {
      ordered: [8, 9],
      cyclic: [],
    });

    expect(rows).toEqual([9, 8]);
  });
});
