import { describe, expect, it } from "vitest";
import type { ChangeSummary } from "../../domain/triage/risk-tier";
import type { ChangeSummarySource } from "../ports/change-summary-source";
import type { PullRequestListing, PullRequestSource } from "../ports/pull-request-source";
import { planReviewOrder } from "./plan-review-order";

/** **モックを使わない。** port にはインメモリ実装を渡す（AGENTS.md §4）。 */
function sourceReturning(listing: PullRequestListing): PullRequestSource {
  return { listPullRequests: () => Promise.resolve(listing) };
}

function failingSource(error: Error): PullRequestSource {
  return { listPullRequests: () => Promise.reject(error) };
}

const SUMMARY: ChangeSummary = {
  changedFileCount: 1,
  changedLineCount: 5,
  touchesSensitivePath: false,
  ciStatus: "passing",
};

/** 材料の口。**渡さなければ「1 件も取れなかった」ものとして扱う。** */
function changesReturning(
  summaries: ReadonlyMap<number, ChangeSummary>,
  unavailable: { pullRequestNumber: number; reason: string }[] = [],
): ChangeSummarySource {
  return { listChangeSummaries: () => Promise.resolve({ summaries, unavailable }) };
}

function failingChanges(error: Error): ChangeSummarySource {
  return { listChangeSummaries: () => Promise.reject(error) };
}

const NO_CHANGES = changesReturning(new Map());

function ref(number: number, baseBranch: string, headBranch: string) {
  return {
    number,
    base: { repository: "1", branch: baseBranch },
    head: { repository: "1", branch: headBranch },
  };
}

const stacked: PullRequestListing = {
  pullRequests: [ref(8, "main", "feat/a"), ref(9, "feat/a", "feat/b")],
  invalid: [],
};

describe("レビュー順序を組み立てる", () => {
  it("取ってきた一覧から、辺と順序が出る", async () => {
    const plan = await planReviewOrder({
      pullRequests: sourceReturning(stacked),
      changes: NO_CHANGES,
    });

    expect(plan.pullRequests).toEqual(stacked.pullRequests);
    expect(plan.edges).toEqual([{ dependent: 9, dependsOn: 8 }]);
    expect(plan.order).toEqual({ ordered: [8, 9], cyclic: [] });
  });

  it("読めなかった PR は結果に残る", async () => {
    // **ここで捨てると、境界が invalid を返すようにした意味が消える**
    const invalid = [{ index: 3, reason: "number: 必須です" }];
    const plan = await planReviewOrder({
      pullRequests: sourceReturning({ ...stacked, invalid }),
      changes: NO_CHANGES,
    });

    expect(plan.invalid).toEqual(invalid);
  });

  it("循環は順序に混ざらず、そのまま伝わる", async () => {
    const plan = await planReviewOrder({
      changes: NO_CHANGES,
      pullRequests: sourceReturning({
        pullRequests: [ref(1, "feat/b", "feat/a"), ref(2, "feat/a", "feat/b")],
        invalid: [],
      }),
    });

    expect(plan.order).toEqual({ ordered: [], cyclic: [1, 2] });
  });

  it("PR が 0 件でも落ちない", async () => {
    const plan = await planReviewOrder({
      pullRequests: sourceReturning({ pullRequests: [], invalid: [] }),
      changes: NO_CHANGES,
    });

    expect(plan).toEqual({
      pullRequests: [],
      edges: [],
      order: { ordered: [], cyclic: [] },
      invalid: [],
      changes: new Map(),
      changesUnavailable: [],
    });
  });

  it("取得に失敗したら、0 件ではなく失敗として伝わる", async () => {
    // **「取得できなかった」と「0 件だった」を区別できること。**
    // 空の計画に丸めると、依存が 1 つも無い画面が正しい顔で出る
    const failure = new Error("401 Unauthorized");

    await expect(
      planReviewOrder({ pullRequests: failingSource(failure), changes: NO_CHANGES }),
    ).rejects.toBe(failure);
  });

  describe("材料の地図", () => {
    it("画面に渡すものが 1 回の呼び出しで揃う", async () => {
      // **2 箇所で組み立てない。** 揃える側が 2 つあると、
      // 片方だけ直したときに食い違う（#112 で並びの持ち主を 1 つにしたのと同じ理由）
      const plan = await planReviewOrder({
        pullRequests: sourceReturning(stacked),
        changes: changesReturning(new Map([[8, SUMMARY]])),
      });

      expect(plan.changes.get(8)).toEqual(SUMMARY);
      expect(plan.order).toEqual({ ordered: [8, 9], cyclic: [] });
    });

    it("材料が無い PR があっても、他の結果と順序は返る", async () => {
      const plan = await planReviewOrder({
        pullRequests: sourceReturning(stacked),
        changes: changesReturning(new Map([[8, SUMMARY]]), [
          { pullRequestNumber: 9, reason: "取れませんでした" },
        ]),
      });

      expect(plan.changes.has(9)).toBe(false);
      expect(plan.changesUnavailable).toEqual([
        { pullRequestNumber: 9, reason: "取れませんでした" },
      ]);
      expect(plan.pullRequests).toHaveLength(2);
    });

    it("材料の取得が丸ごと落ちても、依存グラフは返る", async () => {
      // **決めたこと。** 材料が取れないことは「無い」に化けない——
      // 画面は行を残して「材料がありません」と出すので、**読めなかったと読める**。
      // 一方、**依存グラフだけでも交通整理の役に立つ**ので、そこまで落とさない
      const plan = await planReviewOrder({
        pullRequests: sourceReturning(stacked),
        changes: failingChanges(new Error("GitHub から取得できませんでした")),
      });

      expect(plan.order).toEqual({ ordered: [8, 9], cyclic: [] });
      expect(plan.changes.size).toBe(0);
    });

    it("丸ごと落ちたことを、黙って捨てない", async () => {
      // **「取れなかった」を残す。** 空の地図だけだと、
      // **1 件も材料が無いのか、口が壊れているのかが分からない**
      const plan = await planReviewOrder({
        pullRequests: sourceReturning(stacked),
        changes: failingChanges(new Error("GitHub から取得できませんでした")),
      });

      expect(plan.changesUnavailable.map((entry) => entry.pullRequestNumber)).toEqual([8, 9]);
      expect(plan.changesUnavailable[0]?.reason).toContain("GitHub から取得できませんでした");
    });

    it("材料は、読めた PR の分だけ問い合わせる", async () => {
      // **読めなかった PR の番号は分からない**（`invalid` は位置しか持たない）
      const asked: readonly number[][] = [];
      const numbers: number[][] = [];
      await planReviewOrder({
        pullRequests: sourceReturning(stacked),
        changes: {
          listChangeSummaries: (requested) => {
            numbers.push([...requested]);
            return Promise.resolve({ summaries: new Map(), unavailable: [] });
          },
        },
      });

      expect(asked).toEqual([]);
      expect(numbers).toEqual([[8, 9]]);
    });
  });
});
