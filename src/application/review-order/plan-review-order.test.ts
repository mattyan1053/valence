import { describe, expect, it } from "vitest";
import type { PullRequestListing, PullRequestSource } from "../ports/pull-request-source";
import { planReviewOrder } from "./plan-review-order";

/** **モックを使わない。** port にはインメモリ実装を渡す（AGENTS.md §4）。 */
function sourceReturning(listing: PullRequestListing): PullRequestSource {
  return { listPullRequests: () => Promise.resolve(listing) };
}

function failingSource(error: Error): PullRequestSource {
  return { listPullRequests: () => Promise.reject(error) };
}

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
    const plan = await planReviewOrder(sourceReturning(stacked));

    expect(plan.pullRequests).toEqual(stacked.pullRequests);
    expect(plan.edges).toEqual([{ dependent: 9, dependsOn: 8 }]);
    expect(plan.order).toEqual({ ordered: [8, 9], cyclic: [] });
  });

  it("読めなかった PR は結果に残る", async () => {
    // **ここで捨てると、境界が invalid を返すようにした意味が消える**
    const invalid = [{ index: 3, reason: "number: 必須です" }];
    const plan = await planReviewOrder(sourceReturning({ ...stacked, invalid }));

    expect(plan.invalid).toEqual(invalid);
  });

  it("循環は順序に混ざらず、そのまま伝わる", async () => {
    const plan = await planReviewOrder(
      sourceReturning({
        pullRequests: [ref(1, "feat/b", "feat/a"), ref(2, "feat/a", "feat/b")],
        invalid: [],
      }),
    );

    expect(plan.order).toEqual({ ordered: [], cyclic: [1, 2] });
  });

  it("PR が 0 件でも落ちない", async () => {
    const plan = await planReviewOrder(sourceReturning({ pullRequests: [], invalid: [] }));

    expect(plan).toEqual({
      pullRequests: [],
      edges: [],
      order: { ordered: [], cyclic: [] },
      invalid: [],
    });
  });

  it("取得に失敗したら、0 件ではなく失敗として伝わる", async () => {
    // **「取得できなかった」と「0 件だった」を区別できること。**
    // 空の計画に丸めると、依存が 1 つも無い画面が正しい顔で出る
    const failure = new Error("401 Unauthorized");

    await expect(planReviewOrder(failingSource(failure))).rejects.toBe(failure);
  });
});
