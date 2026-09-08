/**
 * **ボールが誰にあるかを決める**（#636）。
 *
 * **盤面を見て最初に知りたいのは「自分が動く番か」**である。
 *
 * **罠が 1 つある**（#636 の昇格コメント）。**`requested_reviewers` は「まだ返して
 * いない依頼」だけ**で、**レビューを提出すると一覧から消える**——**`reviewers.length
 * === 0` で「放置」と書くと、いちばん動いている PR がいちばん放置に見える。**
 *
 * **判定が正しいかだけを見る**（Issue の本文）。**役に立つかはここでは測れない**
 * ——**一人開発だからである。**
 */

import { describe, expect, it } from "vitest";
import type { MergeBlock } from "../graph/merge-block";
import type { Assignment } from "./assignment";
import type { ReviewOpinion } from "./ball";
import { ballOf } from "./ball";

const NOBODY: Assignment = { assignees: [], reviewers: [], authoredByBot: false };
const REQUESTED: Assignment = { assignees: [], reviewers: ["reviewer"], authoredByBot: false };

const QUIET: ReviewOpinion = {
  approvesHead: false,
  changesRequestedOnHead: false,
  reviewed: false,
};

/** **合流できる**（`mergeReadinessOf` が返す種別）。 */
const MERGEABLE = "mergeable" as const;

/** **依存は残っていない**（`mergeBlockFor` が返すもの）。 */
const READY: MergeBlock = { kind: "ready" };

describe("ボールが誰にあるか", () => {
  it("いまの head に変更が求められていれば、著者の番", () => {
    expect(
      ballOf({
        opinion: { ...QUIET, changesRequestedOnHead: true, reviewed: true },
        readiness: MERGEABLE,
        block: READY,
        assignment: NOBODY,
      }),
    ).toBe("author");
  });

  it("承認済みで合流できるなら、マージする人の番", () => {
    expect(
      ballOf({
        opinion: { ...QUIET, approvesHead: true, reviewed: true },
        readiness: MERGEABLE,
        block: READY,
        assignment: NOBODY,
      }),
    ).toBe("merger");
  });

  it("承認済みでも合流できないなら、マージする人の番とは言わない", () => {
    // **conflict や base の遅れは、押しても入らない**——**その行は別に出ている**（#629）
    expect(
      ballOf({
        opinion: { ...QUIET, approvesHead: true, reviewed: true },
        readiness: "conflicting",
        block: READY,
        assignment: NOBODY,
      }),
    ).not.toBe("merger");
  });

  it("古い commit の承認を、マージする人の番にしない", () => {
    // **#635 で承認は head に固定した**——**`approvesHead` が false なら、
    // 承認そのものが今の差分に付いていない。**
    expect(
      ballOf({
        opinion: { ...QUIET, approvesHead: false, reviewed: true },
        readiness: MERGEABLE,
        block: READY,
        assignment: NOBODY,
      }),
    ).not.toBe("merger");
  });

  it("レビュー依頼が出ていれば、レビューする人の番", () => {
    expect(
      ballOf({ opinion: QUIET, readiness: MERGEABLE, block: READY, assignment: REQUESTED }),
    ).toBe("reviewer");
  });

  it("依頼が無く、レビューも 1 件も無ければ、誰の番でもない", () => {
    expect(ballOf({ opinion: QUIET, readiness: MERGEABLE, block: READY, assignment: NOBODY })).toBe(
      "nobody",
    );
  });

  it("レビュー済みの PR を、放置にしない", () => {
    // **これが #636 の罠である。** **提出したレビュアーは `requested_reviewers` から
    // 消える**ので、**依頼の有無だけで書くと、いちばん動いている PR が放置に見える。**
    expect(
      ballOf({
        opinion: { ...QUIET, reviewed: true },
        readiness: MERGEABLE,
        block: READY,
        assignment: NOBODY,
      }),
    ).not.toBe("nobody");
  });

  it("意見を読めなかった PR を、放置にしない", () => {
    // **「分からない」を「誰の番でもない」へ倒さない**（Issue の「気をつけること」）
    expect(
      ballOf({ opinion: undefined, readiness: MERGEABLE, block: READY, assignment: NOBODY }),
    ).toBe("unknown");
  });

  it("誰に振られているかを読めなかった PR を、放置にしない", () => {
    expect(
      ballOf({ opinion: QUIET, readiness: MERGEABLE, block: READY, assignment: undefined }),
    ).toBe("unknown");
  });

  it("読めていても、規則のどれにも当たらなければ分からないと言う", () => {
    // **レビュー済みだが、承認も変更要求も head に無い**——**依頼も残っていない。**
    // **放置ではない**が、**誰の番かも決まらない。** **`unknown` は「言わない」側である。**
    expect(
      ballOf({
        opinion: { ...QUIET, reviewed: true },
        readiness: MERGEABLE,
        block: READY,
        assignment: NOBODY,
      }),
    ).toBe("unknown");
  });

  it("読めなかった側でも、変更が求められていれば著者の番である", () => {
    // **順序が効く。** **`changesRequestedOnHead` は GitHub が言い切った事実**なので、
    // **持ち主が読めなくても言える。**
    expect(
      ballOf({
        opinion: { ...QUIET, changesRequestedOnHead: true },
        readiness: MERGEABLE,
        block: READY,
        assignment: undefined,
      }),
    ).toBe("author");
  });
});

describe("依存とアサインの扱い（#652 のレビュー）", () => {
  it("依存が残っていれば、マージする人の番とは言わない", () => {
    // **同じ画面が逆のことを言っていた**——**行は「いま入れられます」、
    // ボタンは `depends-on` で無効。** **積み重ねた PR はこのプロダクトの普通**
    // である（§1）ので、**踏める。**
    expect(
      ballOf({
        opinion: { ...QUIET, approvesHead: true, reviewed: true },
        readiness: MERGEABLE,
        block: { kind: "depends-on", numbers: [7] },
        assignment: NOBODY,
      }),
    ).not.toBe("merger");
  });

  it("順序を決められないときも、マージする人の番とは言わない", () => {
    expect(
      ballOf({
        opinion: { ...QUIET, approvesHead: true, reviewed: true },
        readiness: MERGEABLE,
        block: { kind: "not-orderable" },
        assignment: NOBODY,
      }),
    ).not.toBe("merger");
  });

  it("依存を読めていないときも、マージする人の番とは言わない", () => {
    expect(
      ballOf({
        opinion: { ...QUIET, approvesHead: true, reviewed: true },
        readiness: MERGEABLE,
        block: undefined,
        assignment: NOBODY,
      }),
    ).not.toBe("merger");
  });

  it("アサインを読めなくても、マージする人の番だとは言える", () => {
    // **同じ規則が片方にだけ効いていた**——**承認と合流の状況も、GitHub が
    // 言い切った事実**である。**アサインは `reviewer` / `nobody` にしか要らない。**
    expect(
      ballOf({
        opinion: { ...QUIET, approvesHead: true, reviewed: true },
        readiness: MERGEABLE,
        block: READY,
        assignment: undefined,
      }),
    ).toBe("merger");
  });
});
