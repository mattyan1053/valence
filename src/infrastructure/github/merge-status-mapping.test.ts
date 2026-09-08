import { describe, expect, it } from "vitest";
import { toBehindBy, toMergeStatusPage } from "./merge-status-mapping";

function payload(
  nodes: readonly unknown[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
    hasNextPage: false,
    endCursor: null,
  },
): unknown {
  return { data: { repository: { pullRequests: { pageInfo, nodes } } } };
}

function node(number: number, mergeable: string, mergeStateStatus: string): unknown {
  return { number, mergeable, mergeStateStatus };
}

describe("GitHub の合流の状況を読む", () => {
  it("conflict している PR を、そのまま持ち帰る", () => {
    const page = toMergeStatusPage(payload([node(9, "CONFLICTING", "DIRTY")]));

    expect(page.statuses.get(9)).toEqual({ mergeable: "conflicting", state: "dirty" });
  });

  it("base に遅れている PR を、そのまま持ち帰る", () => {
    // **`mergeable` だけだと「conflict はしていないが入らない」が言えない**（#502）
    const page = toMergeStatusPage(payload([node(8, "MERGEABLE", "BEHIND")]));

    expect(page.statuses.get(8)).toEqual({ mergeable: "mergeable", state: "behind" });
  });

  it("いま読む予定の無い状況も、捨てずに持ち帰る", () => {
    // **境界が読んだものを、渡す手前で捨てない**（#628）
    const page = toMergeStatusPage(payload([node(7, "MERGEABLE", "BLOCKED")]));

    expect(page.statuses.get(7)).toEqual({ mergeable: "mergeable", state: "blocked" });
  });

  it("知らない値を、マージできる側へ倒さない", () => {
    // **GitHub が値を増やした日に「問題なし」へ倒れない**
    const page = toMergeStatusPage(payload([node(6, "SOMETHING_NEW", "SOMETHING_NEW")]));

    expect(page.statuses.get(6)).toEqual({ mergeable: "unknown", state: "unknown" });
  });

  it("形の違う PR は持ち帰らない。ほかの PR は読む", () => {
    // **1 件の読み落としで、盤面全部の状況を捨てない**（`toPullRequestRefs` と同じ形）
    const page = toMergeStatusPage(payload([{ number: "9" }, node(8, "MERGEABLE", "CLEAN")]));

    expect(page.statuses.has(9)).toBe(false);
    expect(page.statuses.get(8)).toEqual({ mergeable: "mergeable", state: "clean" });
  });

  it("続きがあるなら、次の位置を返す", () => {
    const page = toMergeStatusPage(payload([], { hasNextPage: true, endCursor: "Y3Vyc29y" }));

    expect(page.nextCursor).toBe("Y3Vyc29y");
  });

  it("続きが無いなら、次の位置は返らない", () => {
    expect(toMergeStatusPage(payload([])).nextCursor).toBeUndefined();
  });

  it("続きがあると言いながら行き先が無い応答は、読めていない", () => {
    // **黙って止めると、残りのページの PR が「一覧に無い」へ落ちる**（#346 のレビュー）
    expect(() => toMergeStatusPage(payload([], { hasNextPage: true, endCursor: null }))).toThrow();
  });

  it("errors が載っている応答は読まない", () => {
    // **GraphQL は 200 のまま失敗を返す**（#346 のレビュー 2 周目）
    expect(() =>
      toMergeStatusPage({
        errors: [{ message: "問題" }],
        data: { repository: { pullRequests: { pageInfo: {}, nodes: [] } } },
      }),
    ).toThrow();
  });

  it("一覧として読めない応答は、空の一覧にしない", () => {
    // **「読めなかった」を「conflict していない」に化けさせない**
    expect(() => toMergeStatusPage({ data: { repository: null } })).toThrow();
  });
});

describe("base にどれだけ遅れているか（#639）", () => {
  const response = (behindBy: unknown) => ({
    data: { repository: { ref: { compare: { behindBy } } } },
  });

  it("応答の数をそのまま返す", () => {
    expect(toBehindBy(response(35))).toBe(35);
  });

  it("遅れていない PR は 0 である", () => {
    expect(toBehindBy(response(0))).toBe(0);
  });

  it("読めない応答を「遅れ 0」にしない", () => {
    // **既定の分岐に落とすと、黙って「遅れていません」になる**（`AGENTS.md` §5）
    expect(toBehindBy(response("35"))).toBeUndefined();
    expect(toBehindBy(response(-1))).toBeUndefined();
    expect(toBehindBy({ data: { repository: { ref: null } } })).toBeUndefined();
    expect(toBehindBy(undefined)).toBeUndefined();
  });

  it("`errors` が載っていたら読まない", () => {
    // **GraphQL は 200 のまま失敗を返す**（#346 のレビュー 2 周目）
    expect(
      toBehindBy({
        ...response(35),
        errors: [{ message: "Could not resolve head ref" }],
      }),
    ).toBeUndefined();
  });
});
