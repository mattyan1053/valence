import { describe, expect, it } from "vitest";
import { SHARED_TITLE_FLOOR, titleOverlapNote } from "./title-overlap-note";

function report(shared: string, partial = false) {
  return { match: { number: 8, shared }, partial };
}

describe("重複しているかもしれない PR を、行の言葉にする", () => {
  it("相手の番号と、同じだった並びを出す", () => {
    // **理由が追えないと、ルールベースである価値が無い**（#630 の完了条件）
    const note = titleOverlapNote(report("リポジトリ一覧に、1 要求ずつの上限を置く"));

    expect(note).toContain("#8");
    expect(note).toContain("リポジトリ一覧に、1 要求ずつの上限を置く");
  });

  it("何文字ぶん同じかを出す", () => {
    // **「似ています」とは言わない**——**数を出す**（#637 / #639 と同じ線）
    expect(titleOverlapNote(report("あ".repeat(SHARED_TITLE_FLOOR)))).toContain(
      `${SHARED_TITLE_FLOOR} 文字`,
    );
  });

  it("「似ている」とは言わない", () => {
    // **言い切ると、重複でないものを重複と呼ぶ**（#630 の「なぜ」）
    expect(titleOverlapNote(report("あ".repeat(30)))).not.toMatch(/似て|重複/);
  });

  it("ここでは数え直さない", () => {
    // **境界は `titleOverlapsFor` へ渡してある**（#653 のレビュー 2 周目）
    // ——**同じ判定を 2 箇所に持たない**（§5）。**境界の両側は domain の試験にある**
    expect(titleOverlapNote(report("あ".repeat(SHARED_TITLE_FLOOR - 1)))).toBeDefined();
  });

  it("絵文字は 1 文字として数える", () => {
    // **`String.length` は UTF-16 の数**（#653 のレビュー 2 周目）
    // ——**gitmoji 1 個が 2 になり、「10 文字ぶん同じ」が事実と違う**
    expect(titleOverlapNote(report("✨🐛♻️"))).toContain("3 文字");
  });

  it("組が無ければ、何も言わない", () => {
    // **平常時に鳴るものは読まれなくなる**（#248）——**行はもう長い**（#597）
    expect(titleOverlapNote({ match: undefined, partial: false })).toBeUndefined();
  });

  it("報告そのものが無ければ、何も言わない", () => {
    expect(titleOverlapNote(undefined)).toBeUndefined();
  });

  it("測り切れていなければ、短くても黙らない", () => {
    // **「読めなかった」を「似ていない」にしない**（#637 と同じ）
    expect(titleOverlapNote({ match: undefined, partial: true })).toMatch(/測り切れ/);
  });

  it("測り切れていないとき、組があれば下限だと言う", () => {
    const note = titleOverlapNote(report("あ".repeat(30), true));

    expect(note).toContain("#8");
    expect(note).toMatch(/読み切れ|下限/);
  });
});
