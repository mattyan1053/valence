import { describe, expect, it } from "vitest";
import type { MergeStatusReport } from "./merge-readiness";
import { mergeReadinessOf } from "./merge-readiness";

function report(overrides: Partial<MergeStatusReport> = {}): MergeStatusReport {
  return { mergeable: "mergeable", state: "clean", ...overrides };
}

describe("押す前に、合流できるかを言う", () => {
  it("conflict している PR は、そう言う", () => {
    // **#502 で押した人には「いまマージできませんでした」しか出ていなかった**
    expect(mergeReadinessOf(report({ mergeable: "conflicting", state: "dirty" }))).toEqual({
      kind: "conflicting",
    });
  });

  it("base に遅れている PR は、そう言う", () => {
    // **conflict していなくても押せない**——**#502 の「35 commits 遅れ」**である
    expect(mergeReadinessOf(report({ state: "behind" }))).toEqual({ kind: "behind" });
  });

  it("GitHub が計算中の PR を、マージできる側へ倒さない", () => {
    // **「まだ分からない」を「マージできる」にしない**（#540 / #541 と同じ向き）
    expect(mergeReadinessOf(report({ mergeable: "unknown", state: "unknown" }))).toEqual({
      kind: "unknown",
    });
  });

  it("状況そのものが読めていない PR も、マージできる側へ倒さない", () => {
    // **一覧に出てこなかった PR**（**読めなかった / 取りに行けなかった**）
    expect(mergeReadinessOf(undefined)).toEqual({ kind: "unknown" });
  });

  it("片方だけ読めていないときも、マージできる側へ倒さない", () => {
    // **食い違っていても緩い側へ倒さない**（`mergeBlockFor` と同じ判断）
    expect(mergeReadinessOf(report({ state: "unknown" }))).toEqual({ kind: "unknown" });
    expect(mergeReadinessOf(report({ mergeable: "unknown", state: "clean" }))).toEqual({
      kind: "unknown",
    });
  });

  it("conflict は、計算中より先に言う", () => {
    // **conflict は GitHub が言い切った事実**である——**そちらを黙らせない**
    expect(mergeReadinessOf(report({ mergeable: "conflicting", state: "unknown" }))).toEqual({
      kind: "conflicting",
    });
  });

  it("合流できる PR では、conflict の話をしない", () => {
    // **平常時に鳴るものは読まれなくなる**（#248）——**言うことが無ければ言わない**
    expect(mergeReadinessOf(report())).toEqual({ kind: "mergeable" });
  });

  it("下書きの PR は、そう言う", () => {
    // **draft は GitHub が押させない**（#644 のレビュー）——**ほかに言う行が無い**ので、
    // **既定の「合流できる」へ落ちると、押せるまま何も出ない**
    expect(mergeReadinessOf(report({ state: "draft" }))).toEqual({ kind: "draft" });
  });

  it("2 つが食い違っていても、緩い側へ倒さない", () => {
    // **`mergeable` は「合流できる」と言い、`state` は `dirty`（合流できない）と言う**
    // ——**ありえない組み合わせだが、来たときに「押せる」へ倒さない**
    // （`mergeBlockFor` と同じ判断）
    expect(mergeReadinessOf(report({ mergeable: "mergeable", state: "dirty" }))).toEqual({
      kind: "conflicting",
    });
  });

  it("保護ルールで止まっている PR を、マージできる側へ倒さない", () => {
    // **`ApprovalBadge` は「1 件でもあれば承認済み」**（#644 のレビュー 2 周目）
    // ——**必要な数に届いているかは見ていない**ので、**「2 件必要で 1 件」の行は
    // 事実と逆を言う。** **未解決スレッドを言う行は、どこにも無い**
    expect(mergeReadinessOf(report({ state: "blocked" }))).toEqual({ kind: "blocked" });
  });

  it("CI が通っていないことは、合流の話として言わない", () => {
    // **押せない理由は 1 つではない**——**CI はリスク Tier が言う**（`CI_TEXT`）。
    // **同じことを 2 箇所で言うと、片方が事実と違う日が来る**
    expect(mergeReadinessOf(report({ state: "unstable" }))).toEqual({ kind: "mergeable" });
  });
});
