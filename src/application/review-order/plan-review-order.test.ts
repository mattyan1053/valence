import { describe, expect, it } from "vitest";
import type { ChangeSummary } from "../../domain/triage/risk-tier";
import type { ChangeSummarySource, UnavailableChangeSummary } from "../ports/change-summary-source";
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
  unavailable: UnavailableChangeSummary[] = [],
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
          { pullRequestNumber: 9, kind: "unreadable", reason: "取れませんでした" },
        ]),
      });

      expect(plan.changes.has(9)).toBe(false);
      expect(plan.changesUnavailable).toEqual([
        { pullRequestNumber: 9, kind: "unreadable", reason: "取れませんでした" },
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

    describe("材料が遅いとき", () => {
      /**
       * **本当に応答しない口。** resolve も reject もしない。
       *
       * **即座に resolve / reject する偽物では確かめられない**（Issue #120 の完了条件）——
       * それは**遅い口ではなく、落ちる口**である。**起こりえない状態を作る偽物**では、
       * **実装が待ち続けていても緑になる**。
       */
      function silentChanges(): {
        source: ChangeSummarySource;
        asked: number[][];
        /** 口が呼ばれたら解決する。**呼ばれてから打ち切る**ために使う。 */
        called: Promise<AbortSignal | undefined>;
      } {
        const asked: number[][] = [];
        let announce: (signal: AbortSignal | undefined) => void = () => {
          // 呼ばれる前に置き換わる
        };
        const called = new Promise<AbortSignal | undefined>((resolve) => {
          announce = resolve;
        });
        return {
          asked,
          called,
          source: {
            listChangeSummaries: (numbers, request) => {
              asked.push([...numbers]);
              announce(request?.signal);
              return new Promise<never>(() => {
                // わざと何も起こさない
              });
            },
          },
        };
      }

      it("打ち切れば、応答しない口でも依存グラフが返る", async () => {
        // **「壊れたときに縮退する」と「遅いときに縮退する」は別である**（#119 / #120）。
        // 落ちるなら縮退するが、**遅い場合はそこへ入らず、呼び出し側の時間切れで
        // 画面ごと落ちる**
        const deadline = new AbortController();
        const { source, called } = silentChanges();

        const planned = planReviewOrder(
          { pullRequests: sourceReturning(stacked), changes: source },
          { changesDeadline: deadline.signal },
        );
        // **呼ばれてから打ち切る。** 先に切ると「呼ばない」経路へ入り、
        // **待つのをやめる側**を試せない（時間では待たない）
        await called;
        deadline.abort();
        const plan = await planned;

        expect(plan.order).toEqual({ ordered: [8, 9], cyclic: [] });
        expect(plan.changes.size).toBe(0);
      });

      it("打ち切ったことが、材料が無いことと混ざらない", async () => {
        // **打ち切りを入れる側が、打ち切りを見えなくしてはいけない。**
        // **「読めなかった」と「間に合わなかった」は別**で、
        // **文言で見分けさせない**（読む側が文字列を解釈することになる）
        const deadline = new AbortController();
        const { source, called } = silentChanges();

        const planned = planReviewOrder(
          { pullRequests: sourceReturning(stacked), changes: source },
          { changesDeadline: deadline.signal },
        );
        await called;
        deadline.abort();
        const plan = await planned;

        expect(plan.changesUnavailable.map((entry) => entry.pullRequestNumber)).toEqual([8, 9]);
        expect(plan.changesUnavailable.every((entry) => entry.kind === "timedout")).toBe(true);
      });

      it("落ちた場合は、打ち切りとは別の種別になる", async () => {
        // **同じ場所に出るが、同じものではない。** ここが 1 つに潰れると、
        // **#112 以降ずっと分けてきた区別（読めなかった / 無かった）が、
        // 縮退の実装そのものによって潰れる**
        const plan = await planReviewOrder({
          pullRequests: sourceReturning(stacked),
          changes: failingChanges(new Error("GitHub から取得できませんでした")),
        });

        expect(plan.changesUnavailable.every((entry) => entry.kind === "unreadable")).toBe(true);
      });

      it("打ち切りは、口にも伝える", async () => {
        // **先に返すだけでは、走っている要求は走り続ける**（master の指摘）。
        // **取り消しを口まで通さないと、縮退したのは呼んだ側だけ**になる
        const deadline = new AbortController();
        const { source, called } = silentChanges();

        const planned = planReviewOrder(
          { pullRequests: sourceReturning(stacked), changes: source },
          { changesDeadline: deadline.signal },
        );
        const seen = await called;
        deadline.abort();
        await planned;

        expect(seen, "口に合図が渡っていない").toBe(deadline.signal);
      });

      it("先に期限が切れていれば、口を呼ばない", async () => {
        // **呼んでから打ち切らない。** 呼べば往復が始まるので、
        // **打ち切ったのに要求だけ飛ぶ**ことになる
        const deadline = new AbortController();
        deadline.abort();
        const { source, asked } = silentChanges();

        const plan = await planReviewOrder(
          { pullRequests: sourceReturning(stacked), changes: source },
          { changesDeadline: deadline.signal },
        );

        expect(asked).toEqual([]);
        expect(plan.changesUnavailable).toHaveLength(2);
      });
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
