import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DependencyEdge, PullRequestRef } from "../../domain/graph/dependency-graph";
import type { DependencyOrder } from "../../domain/graph/dependency-order";
import type { DependencyGraphViewProps } from "./dependency-graph-view";
import { DependencyGraphView } from "./dependency-graph-view";

/**
 * **本物の DOM を用意しない。** 見たいのは「何が画面に出るか」であって、
 * ブラウザの挙動ではない。文字列へ描けば、jsdom も testing-library も要らない。
 */
function render(props: DependencyGraphViewProps): string {
  return renderToStaticMarkup(createElement(DependencyGraphView, props));
}

function pullRequest(number: number, base: string, head: string): PullRequestRef {
  return {
    number,
    base: { repository: "r", branch: base },
    head: { repository: "r", branch: head },
  };
}

/** #2 が #1 の上に積まれている、いちばん小さなスタック。 */
const STACK: readonly PullRequestRef[] = [
  pullRequest(1, "main", "feat/a"),
  pullRequest(2, "feat/a", "feat/b"),
];
const STACK_EDGES: readonly DependencyEdge[] = [{ dependent: 2, dependsOn: 1 }];
const STACK_ORDER: DependencyOrder = { ordered: [1, 2], cyclic: [] };

function props(overrides: Partial<DependencyGraphViewProps> = {}): DependencyGraphViewProps {
  return {
    pullRequests: STACK,
    edges: STACK_EDGES,
    order: STACK_ORDER,
    invalid: [],
    ...overrides,
  };
}

describe("DependencyGraphView", () => {
  it("土台が先、その上に積まれたものが後に出る", () => {
    // **並びは `order.ordered` が持っている。** ここで並べ替え直さない
    const markup = render(
      props({ pullRequests: [STACK[1] as PullRequestRef, STACK[0] as PullRequestRef] }),
    );

    expect(markup.indexOf("#1")).toBeGreaterThanOrEqual(0);
    expect(markup.indexOf("#1")).toBeLessThan(markup.indexOf("#2"));
  });

  it("何の上に積まれているかが分かる", () => {
    const markup = render(props());

    expect(markup).toContain("#1");
    expect(markup).toContain("feat/b");
  });

  describe("読めなかった PR", () => {
    it("1 件でもあれば、図に抜けがあることが分かる", () => {
      // **黙って省くと、欠けた図が完全な図の顔で出る。**
      // このリポジトリが #60 / #62 / #64 / #67 / #76 / #86 で繰り返し塞いできた形
      const markup = render(props({ invalid: [{ index: 3, reason: "番号が数値ではありません" }] }));

      expect(markup).toMatch(/抜け/);
      // **何件あるかまで出す。** 「あります」だけだと、1 件なのか 20 件なのか分からない
      expect(markup).toContain("1 件");
      expect(markup).toContain("番号が数値ではありません");
    });

    it("0 件のときと見分けが付く", () => {
      // **常に同じ注意書きを出すと、出ている意味が無くなる**
      expect(render(props({ invalid: [] }))).not.toMatch(/抜け/);
    });
  });

  describe("並べられなかった PR", () => {
    it("循環に含まれる PR が画面から消えない", () => {
      // **`ordered` に入らないので、そこだけ描くと画面から消える。**
      // 「並べられなかった」であって「無い」ではない
      const markup = render(
        props({
          order: { ordered: [], cyclic: [1, 2] },
        }),
      );

      expect(markup).toContain("#1");
      expect(markup).toContain("#2");
      expect(markup).toMatch(/並べられ|循環/);
    });

    it("循環が無いときは、その断りを出さない", () => {
      expect(render(props())).not.toMatch(/並べられ|循環/);
    });

    it("順序にも循環にも出ない PR は、一覧から漏らさない", () => {
      // **どこにも並ばない PR が黙って消えるのを防ぐ**（順序の計算が変わっても、
      // 画面から PR が消えることは無い）
      const markup = render(props({ order: { ordered: [1], cyclic: [] } }));

      expect(markup).toContain("#2");
    });
  });

  it("1 件も無くても壊れない", () => {
    const markup = render(
      props({ pullRequests: [], edges: [], order: { ordered: [], cyclic: [] } }),
    );

    expect(markup).toMatch(/PR/);
  });
});
