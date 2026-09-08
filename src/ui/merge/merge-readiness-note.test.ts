import { describe, expect, it } from "vitest";
import type { MergeReadiness } from "../../domain/graph/merge-readiness";
import { baseLagNote, mergeReadinessNote } from "./merge-readiness-note";

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

  it("下書きのままであることが分かる", () => {
    // **draft は GitHub が押させる前に止める**（#644 のレビュー）
    expect(note("draft")).toContain("下書き");
  });

  it("保護ルールで止まっていることが分かる", () => {
    // **どの規則かまでは言わない**（#644 のレビュー 2 周目）——**`BLOCKED` は寄せ集め**
    // なので、**言い切ると `BEHIND` と同じ断定が生まれる**
    expect(note("blocked")).toContain("保護ルール");
  });

  it("言い分けられている", () => {
    // **上のそれぞれが空でないことを、ここが支えている**——**同じ文なら、
    // 分けた意味が無い**（`changeUnavailableNote` と同じ判断）
    const texts = [
      note("conflicting"),
      note("behind"),
      note("draft"),
      note("blocked"),
      note("unknown"),
    ];

    expect(new Set(texts).size, "言い分けられていない").toBe(5);
  });

  it("次に何をすればよいかまで言う", () => {
    // **「押せない」だけでは、何をすればよいか分からない**（#345 と同じ理由）
    expect(note("conflicting")).toContain("解消");
    expect(note("behind")).toContain("取り込み直");
  });
});

describe("base にどれだけ遅れているかを、数で出す", () => {
  // **#502 は「35 commits 遅れ」だった**（#639）——**その数が画面のどこにも
  // 出ていなかった。** **言い切る前に、まず数を出す**（Issue の本文）。
  it("遅れている数を、そのまま出す", () => {
    expect(baseLagNote(35)).toContain("35");
  });

  it("遅れていないなら、何も言わない", () => {
    // **平常時に鳴るものは読まれなくなる**（#248）
    expect(baseLagNote(0)).toBeUndefined();
  });

  it("読めなかったものを、「遅れ 0」にしない", () => {
    // **既定の分岐に落とすと、黙って「遅れていません」になる**
    // （`AGENTS.md` §5。#639 の昇格コメント）——**言うことが無いのと同じ扱い**にする。
    expect(baseLagNote(undefined)).toBeUndefined();
  });

  it("「遅れすぎ」とは言わない", () => {
    // **何コミットから遅れすぎかは人が決める**（Issue の「気をつけること」）
    // ——**境界を外すと、直さなくてよいものを直させる。**
    expect(baseLagNote(35)).not.toMatch(/すぎ|遅すぎ|取り込み直さないと/);
  });
});
