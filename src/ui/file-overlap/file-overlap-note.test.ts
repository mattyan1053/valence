import { describe, expect, it } from "vitest";
import { fileOverlapNote } from "./file-overlap-note";

describe("同じファイルを触る PR を、行の言葉にする", () => {
  it("相手の番号と数を出す", () => {
    const note = fileOverlapNote({
      overlaps: [
        { number: 8, count: 3 },
        { number: 9, count: 1 },
      ],
      partial: false,
    });

    expect(note).toContain("#8");
    expect(note).toContain("3");
    expect(note).toContain("#9");
  });

  it("「衝突する」とは言わない", () => {
    // **同じファイルでも、離れた行なら衝突しない**（#637 の「気をつけること」）
    // ——**言い切ると、避けなくてよい順序を押し付ける**
    const note = fileOverlapNote({ overlaps: [{ number: 8, count: 3 }], partial: false });

    expect(note).not.toMatch(/衝突|コンフリクト/);
  });

  it("測り切れていないときは、下限だと言う", () => {
    // **「測れなかった」を「重なっていない」にしない**（#637）
    const note = fileOverlapNote({ overlaps: [{ number: 8, count: 1 }], partial: true });

    expect(note).toContain("下限");
  });

  it("重なりが見えなくても、測り切れていなければ黙らない", () => {
    const note = fileOverlapNote({ overlaps: [], partial: true });

    expect(note).toMatch(/測り切れ|下限/);
  });

  it("重なりが無く、測り切れていれば、何も言わない", () => {
    // **平常時に鳴るものは読まれなくなる**（#248）——**行はもう長い**（#597）
    expect(fileOverlapNote({ overlaps: [], partial: false })).toBeUndefined();
  });

  it("報告そのものが無ければ、何も言わない", () => {
    expect(fileOverlapNote(undefined)).toBeUndefined();
  });
});
