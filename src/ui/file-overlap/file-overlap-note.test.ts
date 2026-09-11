import { describe, expect, it } from "vitest";
import { fileOverlapLimitNote, fileOverlapNote } from "./file-overlap-note";

describe("同じファイルを触る PR を、行の言葉にする", () => {
  it("相手の番号と数を出す", () => {
    const note = fileOverlapNote([
      { number: 8, count: 3 },
      { number: 9, count: 1 },
    ]);

    expect(note).toContain("#8");
    expect(note).toContain("3");
    expect(note).toContain("#9");
  });

  it("「衝突する」とは言わない", () => {
    // **同じファイルでも、離れた行なら衝突しない**（#637 の「気をつけること」）
    // ——**言い切ると、避けなくてよい順序を押し付ける**
    const note = fileOverlapNote([{ number: 8, count: 3 }]);

    expect(note).not.toMatch(/衝突|コンフリクト/);
  });

  it("測り切れていないことを、行は言わない", () => {
    // **盤面ぜんたいの事実**である（#702）——**行ごとに違わない値を行が言うと、
    // 12 行の盤面で同じ 1 文が 10 回出る**
    const note = fileOverlapNote([{ number: 8, count: 1 }]);

    expect(note, "行が盤面の事実を言っている").not.toMatch(/測り切れ|下限/);
  });

  it("重なりが無ければ、行は何も言わない", () => {
    // **平常時に鳴るものは読まれなくなる**（#248）——**行はもう長い**（#597）
    expect(fileOverlapNote([])).toBeUndefined();
  });

  it("行の材料そのものが無ければ、何も言わない", () => {
    expect(fileOverlapNote(undefined)).toBeUndefined();
  });
});

describe("測り切れていないことは、盤面が 1 回だけ言う（#702）", () => {
  it("測り切れていなければ、盤面が言う", () => {
    // **「測れなかった」を「重なっていない」にしない**（#637）——**言う場所が
    // 行から盤面へ移っただけ**である
    expect(fileOverlapLimitNote(true)).toMatch(/測り切れ/);
  });

  it("測り切れていれば、黙る", () => {
    expect(fileOverlapLimitNote(false)).toBeUndefined();
  });

  it("測り切れなかった理由を名指さない", () => {
    // **理由は 1 つではない**（#656）——**一覧が見切れている / 材料が取れていない /
    // 一覧から読めなかった / 組が多すぎて区切った。** **`OverlapReports.partial` は
    // 真偽値 1 つ**で、**どれだったかは持っていない**——**名指すと、当たっていない
    // ほうを言うことがある。**
    expect(fileOverlapLimitNote(true), "持っていない理由を名指している").not.toMatch(
      /読み切れていない/,
    );
  });
});
