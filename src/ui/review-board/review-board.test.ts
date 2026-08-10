import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DependencyEdge, PullRequestRef } from "../../domain/graph/dependency-graph";
import type { DependencyOrder } from "../../domain/graph/dependency-order";
import type { ChangeSummary } from "../../domain/triage/risk-tier";
import type { ReviewBoardProps } from "./review-board";
import { ReviewBoard } from "./review-board";

function render(props: ReviewBoardProps): string {
  return renderToStaticMarkup(createElement(ReviewBoard, props));
}

function pullRequest(number: number, base: string, head: string): PullRequestRef {
  return {
    number,
    base: { repository: "r", branch: base },
    head: { repository: "r", branch: head },
  };
}

function change(overrides: Partial<ChangeSummary> = {}): ChangeSummary {
  return {
    changedFileCount: 1,
    changedLineCount: 5,
    touchesSensitivePath: false,
    ciStatus: "passing",
    ...overrides,
  };
}

/** #2 が #1 の上に積まれている、いちばん小さなスタック。 */
const STACK: readonly PullRequestRef[] = [
  pullRequest(1, "main", "feat/a"),
  pullRequest(2, "feat/a", "feat/b"),
];
const EDGES: readonly DependencyEdge[] = [{ dependent: 2, dependsOn: 1 }];
const ORDER: DependencyOrder = { ordered: [1, 2], cyclic: [] };

function props(overrides: Partial<ReviewBoardProps> = {}): ReviewBoardProps {
  return {
    pullRequests: STACK,
    edges: EDGES,
    order: ORDER,
    invalid: [],
    changes: new Map([
      [1, change()],
      [2, change()],
    ]),
    ...overrides,
  };
}

describe("ReviewBoard", () => {
  it("依存の順に並んだ各行に Tier が出る", () => {
    const markup = render(props());

    expect(markup.indexOf("#1")).toBeLessThan(markup.indexOf("#2"));
    // 2 件とも Tier が出ている（#110 の表示をそのまま使う）
    expect(markup.match(/すぐ通せる/g)).toHaveLength(2);
  });

  it("Tier で並べ替えない", () => {
    // **依存の順は守らないとマージできない制約**で、**Tier は優先度の目安**でしかない。
    // 混ぜると「急ぐべき PR が先に見える」せいで、**土台より先に積み荷をマージしようとする**
    // ——このプロダクトが解こうとしている問題を、画面が作り出すことになる
    const markup = render(
      props({
        changes: new Map([
          [1, change()], // fast-track（土台）
          [2, change({ touchesSensitivePath: true })], // high-risk（その上）
        ]),
      }),
    );

    expect(markup.indexOf("#1")).toBeLessThan(markup.indexOf("#2"));
    expect(markup.indexOf("すぐ通せる")).toBeLessThan(markup.indexOf("先に人が見る"));
  });

  describe("判定材料が無い PR", () => {
    it("行として残り、Tier が不明だと分かる", () => {
      // **黙って落とさない。** #107 の `invalid` と同じ形で、
      // 「出せなかった」を「無かった」にしない
      const markup = render(props({ changes: new Map([[1, change()]]) }));

      expect(markup).toContain("#2");
      expect(markup).toMatch(/材料|不明|分かりません/);
    });

    it("材料が揃っていれば、その断りを出さない", () => {
      expect(render(props())).not.toMatch(/材料|不明|分かりません/);
    });
  });

  it("依存グラフ側の注意書きが消えない", () => {
    // **合成しても、#107 が塞いだ穴が開かない**こと
    const markup = render(
      props({
        order: { ordered: [1], cyclic: [2] },
        invalid: [{ index: 4, reason: "番号が数値ではありません" }],
      }),
    );

    expect(markup).toMatch(/抜け/);
    expect(markup).toMatch(/その先に積まれ/);
    expect(markup).toContain("番号が数値ではありません");
  });
});
