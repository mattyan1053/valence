import { describe, expect, it } from "vitest";
import type { MergeReadiness } from "../../domain/graph/merge-readiness";
import { mergeReadinessNote } from "./merge-readiness-note";

function note(kind: MergeReadiness["kind"]): string | undefined {
  return mergeReadinessNote({ kind });
}

describe("合流の状況を、行の言葉にする", () => {
  it("合流できるときは、何も言わない", () => {
    // **平常時に鳴るものは読まれなくなる**（#248）——**10 本並ぶと、
    // 読むのは普通でない行だけ**である
    expect(note("mergeable")).toBeUndefined();
  });

  it("conflict していることが分かる", () => {
    expect(note("conflicting")).toContain("conflict");
  });

  it("base に遅れていることが分かる", () => {
    expect(note("behind")).toContain("遅れ");
  });

  it("まだ分からないことが分かる", () => {
    // **「マージできる」とは言わない**（#540 / #541 と同じ向き）
    expect(note("unknown")).toContain("分かりません");
  });

  it("conflict と、遅れと、分からないを、同じ文にしない", () => {
    // **上の 3 つが空でないことを、ここが支えている**——**同じ文なら、
    // 分けた意味が無い**（`changeUnavailableNote` と同じ判断）
    const texts = [note("conflicting"), note("behind"), note("unknown")];

    expect(new Set(texts).size, "言い分けられていない").toBe(3);
  });

  it("次に何をすればよいかまで言う", () => {
    // **「押せない」だけでは、何をすればよいか分からない**（#345 と同じ理由）
    expect(note("conflicting")).toContain("解消");
    expect(note("behind")).toContain("取り込み直");
  });
});
