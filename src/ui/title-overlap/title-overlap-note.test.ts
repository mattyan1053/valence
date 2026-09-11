import { describe, expect, it } from "vitest";
import { SHARED_TITLE_FLOOR, titleOverlapLimitNote, titleOverlapNote } from "./title-overlap-note";

function match(shared: string) {
  return { number: 8, shared };
}

describe("重複しているかもしれない PR を、行の言葉にする", () => {
  it("相手の番号と、同じだった並びを出す", () => {
    // **理由が追えないと、ルールベースである価値が無い**（#630 の完了条件）
    const note = titleOverlapNote(match("リポジトリ一覧に、1 要求ずつの上限を置く"));

    expect(note).toContain("#8");
    expect(note).toContain("リポジトリ一覧に、1 要求ずつの上限を置く");
  });

  it("何文字ぶん同じかを出す", () => {
    // **「似ています」とは言わない**——**数を出す**（#637 / #639 と同じ線）
    expect(titleOverlapNote(match("あ".repeat(SHARED_TITLE_FLOOR)))).toContain(
      `${SHARED_TITLE_FLOOR} 文字`,
    );
  });

  it("「似ている」とは言わない", () => {
    // **言い切ると、重複でないものを重複と呼ぶ**（#630 の「なぜ」）
    expect(titleOverlapNote(match("あ".repeat(30)))).not.toMatch(/似て|重複/);
  });

  it("ここでは数え直さない", () => {
    // **境界は `titleOverlapsFor` へ渡してある**（#653 のレビュー 2 周目）
    // ——**同じ判定を 2 箇所に持たない**（§5）。**境界の両側は domain の試験にある**
    expect(titleOverlapNote(match("あ".repeat(SHARED_TITLE_FLOOR - 1)))).toBeDefined();
  });

  it("絵文字は 1 文字として数える", () => {
    // **`String.length` は UTF-16 の数**（#653 のレビュー 2 周目）
    // ——**gitmoji 1 個が 2 になり、「10 文字ぶん同じ」が事実と違う**
    expect(titleOverlapNote(match("✨🐛♻️"))).toContain("3 文字");
  });

  it("組が無ければ、何も言わない", () => {
    // **平常時に鳴るものは読まれなくなる**（#248）——**行はもう長い**（#597）
    expect(titleOverlapNote(undefined)).toBeUndefined();
  });

  it("測り切れていないことを、行は言わない", () => {
    // **盤面ぜんたいの事実**である（#702）——**12 行の盤面で、同じ 1 文が 12 回出ていた**
    expect(titleOverlapNote(match("あ".repeat(30))), "行が盤面の事実を言っている").not.toMatch(
      /測り切れ|下限/,
    );
  });
});

describe("測り切れていないことは、盤面が 1 回だけ言う（#702）", () => {
  it("測り切れていなければ、盤面が言う", () => {
    // **「読めなかった」を「似ていない」にしない**（#637 と同じ）——**言う場所が
    // 行から盤面へ移っただけ**である
    expect(titleOverlapLimitNote(true)).toMatch(/測り切れ/);
  });

  it("測り切れていれば、黙る", () => {
    expect(titleOverlapLimitNote(false)).toBeUndefined();
  });

  it("測り切れなかった理由を名指さない", () => {
    // **理由は 1 つではない**（#656）——**タイトルが読めなかった / 一覧から
    // 読めなかった / 長すぎて先頭までしか比べていない（`COMPARED_PREFIX`）/
    // 組が多すぎて区切った（`COMPARISON_BUDGET`）。** **`partial` は真偽値 1 つ**で、
    // **どれだったかは持っていない**——**名指すと、当たっていないほうを言う。**
    expect(titleOverlapLimitNote(true), "持っていない理由を名指している").not.toMatch(
      /読み切れていない/,
    );
  });
});
