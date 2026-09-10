import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DependencyOrder } from "../../domain/graph/dependency-order";
import { MergePlanButton, mergePlanNotice, mergePlanSteps } from "./merge-plan-button";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function order(overrides: Partial<DependencyOrder> = {}): DependencyOrder {
  return { ordered: [1, 2], cyclic: [], ...overrides };
}

describe("mergePlanSteps", () => {
  it("依存の順に並べる", () => {
    // **並べ替えない**——**並びは domain が決めている**
    expect(mergePlanSteps(order({ ordered: [2, 1] }), () => SHA_A)).toEqual([
      { number: 2, headSha: SHA_A },
      { number: 1, headSha: SHA_A },
    ]);
  });

  it("commit が分からない PR は、並びに入れない", () => {
    // **固定できないものを流さない**（#331）——**`MergeButton` と同じ判断**
    const steps = mergePlanSteps(order(), (number) => (number === 1 ? SHA_A : undefined));

    expect(steps).toEqual([{ number: 1, headSha: SHA_A }]);
  });

  it("順序を決められないぶんは、並びに入らない", () => {
    // **`cyclic` は `ordered` に無い**——**先に入れるものを名指しできない**
    expect(mergePlanSteps(order({ ordered: [], cyclic: [1, 2] }), () => SHA_A)).toEqual([]);
  });
});

describe("mergePlanNotice", () => {
  it("止まった番号を言う", () => {
    const line = mergePlanNotice("not-mergeable", 7);

    expect(line).toContain("#7");
    expect(line).toContain("それ以降は入っていません");
  });

  it("入った本数は言わない", () => {
    // **URL から出すと、流していない人が「N 本入りました」と出せる**（#342 のレビュー）
    expect(mergePlanNotice("base-changed", 7)).not.toMatch(/[0-9]+ 本/);
  });

  it("承認されていない head を、そう言う", () => {
    // **承認は commit に付く**（#635）
    expect(mergePlanNotice("not-approved", 3)).toContain("承認されていません");
  });

  it("番号が無くても、行を消さない", () => {
    // **理由だけは伝わる**——**黙ると、押した人には何も起きなかったように見える**
    expect(mergePlanNotice("unavailable", undefined)).not.toBe("");
  });

  it("1 本も流していないときは、番号を言わない", () => {
    expect(mergePlanNotice("nothing-to-run", undefined)).not.toContain("#");
    // **最初の認可で拒まれたときは、止まった番号そのものが無い**
    expect(mergePlanNotice("forbidden", undefined)).not.toContain("#");
  });

  it("途中で権限を失ったときも、止まった番号を言う", () => {
    // **先の本が入ったあとに write を失うと、そこから先が `forbidden` になる**（#665 のレビュー）
    // ——**理由だけを出すと、入ったぶんまで「何も起きなかった」ように見える**
    const line = mergePlanNotice("forbidden", 3);

    expect(line, "止まった番号が消えている").toContain("#3");
    expect(line).toContain("権限がありません");
  });

  it("理由ごとに、別のことを言う", () => {
    // **1 つでも同じだと、そこで区別が消える**
    const kinds = [
      "not-approved",
      "not-mergeable",
      "dependency-pending",
      "base-changed",
      "not-orderable",
      "unavailable",
    ] as const;

    expect(new Set(kinds.map((kind) => mergePlanNotice(kind, 1))).size).toBe(kinds.length);
  });
});

describe("MergePlanButton", () => {
  function render(steps: readonly { number: number; headSha: string }[]): string {
    return renderToStaticMarkup(
      createElement(MergePlanButton, { action: "/repos/acme/web/merge-plan", steps }),
    );
  }

  it("見せた並びと commit を、そのまま送る", () => {
    // **押した対象を、盤面が見せた対象に固定する**（#331）
    const markup = render([
      { number: 1, headSha: SHA_A },
      { number: 2, headSha: SHA_B },
    ]);

    expect(markup).toContain(`value="1:${SHA_A}"`);
    expect(markup).toContain(`value="2:${SHA_B}"`);
  });

  it("何本流すかを、押す前に出す", () => {
    expect(render([{ number: 1, headSha: SHA_A }])).toContain("1 本");
  });

  it("流すものが無ければ、押させない", () => {
    expect(render([])).toContain("disabled");
  });

  it("POST で送る", () => {
    // **GET だと、URL を開くだけでマージが走る**
    expect(render([{ number: 1, headSha: SHA_A }])).toContain('method="post"');
  });
});
