import { describe, expect, it } from "vitest";
import { toPullRequestRefs } from "../../infrastructure/github/pull-request-mapping";
import type { PullRequestListing, PullRequestMapper } from "../ports/pull-request-mapper";
import type { PullRequestSource } from "../ports/pull-request-source";
import { planReviewOrder } from "./plan-review-order";

/** **モックを使わない。** port にはインメモリ実装を渡す（AGENTS.md §4）。 */
function sourceReturning(response: unknown): PullRequestSource {
  return { listPullRequests: () => Promise.resolve(response) };
}

function failingSource(error: Error): PullRequestSource {
  return { listPullRequests: () => Promise.reject(error) };
}

function mapperReturning(listing: PullRequestListing): PullRequestMapper {
  return () => listing;
}

/** 変換を通さずに参照だけ作る道具。ユースケースが見るのは変換の結果だけ。 */
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
      source: sourceReturning([]),
      mapper: mapperReturning(stacked),
    });

    expect(plan.pullRequests).toEqual(stacked.pullRequests);
    expect(plan.edges).toEqual([{ dependent: 9, dependsOn: 8 }]);
    expect(plan.order).toEqual({ ordered: [8, 9], cyclic: [] });
  });

  it("取ってきた応答を、そのまま変換へ渡す", async () => {
    // **結線を見る。** 別のものを渡していると、実データで初めて壊れる
    const response = [{ number: 8 }];
    let received: unknown;
    await planReviewOrder({
      source: sourceReturning(response),
      mapper: (input) => {
        received = input;
        return stacked;
      },
    });

    expect(received).toBe(response);
  });

  it("読めなかった PR は結果に残る", async () => {
    // **ここで捨てると、境界が invalid を返すようにした意味が消える**
    const invalid = [{ index: 3, reason: "number: 必須です" }];
    const plan = await planReviewOrder({
      source: sourceReturning([]),
      mapper: mapperReturning({ ...stacked, invalid }),
    });

    expect(plan.invalid).toEqual(invalid);
  });

  it("循環は順序に混ざらず、そのまま伝わる", async () => {
    const plan = await planReviewOrder({
      source: sourceReturning([]),
      mapper: mapperReturning({
        pullRequests: [ref(1, "feat/b", "feat/a"), ref(2, "feat/a", "feat/b")],
        invalid: [],
      }),
    });

    expect(plan.order).toEqual({ ordered: [], cyclic: [1, 2] });
  });

  it("PR が 0 件でも落ちない", async () => {
    const plan = await planReviewOrder({
      source: sourceReturning([]),
      mapper: mapperReturning({ pullRequests: [], invalid: [] }),
    });

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

    await expect(
      planReviewOrder({ source: failingSource(failure), mapper: mapperReturning(stacked) }),
    ).rejects.toBe(failure);
  });

  it("一覧そのものが読めなければ、失敗として伝わる", async () => {
    await expect(
      planReviewOrder({
        source: sourceReturning({ message: "Not Found" }),
        mapper: toPullRequestRefs,
      }),
    ).rejects.toThrow();
  });

  it("実際の応答から、順序まで出る", async () => {
    // **境界の変換と繋いだ形で 1 度は通す。** 型が合うことと、実物で動くことは別
    const response = [
      {
        number: 8,
        base: { ref: "main", repo: { id: 1327515899 } },
        head: { ref: "chore/docker-improvements", repo: { id: 1327515899 } },
      },
      {
        number: 9,
        base: { ref: "chore/docker-improvements", repo: { id: 1327515899 } },
        head: { ref: "chore/agent-config", repo: { id: 1327515899 } },
      },
      { number: 10, base: { ref: "main" } },
    ];

    const plan = await planReviewOrder({
      source: sourceReturning(response),
      mapper: toPullRequestRefs,
    });

    expect(plan.edges).toEqual([{ dependent: 9, dependsOn: 8 }]);
    expect(plan.order.ordered).toEqual([8, 9]);
    expect(plan.invalid).toHaveLength(1);
  });
});
