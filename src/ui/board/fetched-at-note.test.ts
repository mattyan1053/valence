import { describe, expect, it } from "vitest";
import { fetchedAtNote } from "./fetched-at-note";

describe("いつ取ったものかを、行の言葉にする", () => {
  it("取れた時刻を出す", () => {
    const note = fetchedAtNote(new Date("2026-09-10T12:20:02.000Z"));

    expect(note).toContain("2026-09-10T12:20:02Z");
  });

  it("「新しい」とも「古い」とも言わない", () => {
    // **読む人が決められるように、数を出すところまでにする**（#664 / #639 と同じ線）
    // ——**言い切ると、開いたまま置かれた盤面が「最新」を名乗る**
    const note = fetchedAtNote(new Date("2026-09-10T12:20:02.000Z"));

    expect(note, "こちらが決めてしまっている").not.toMatch(/新しい|最新|古い/);
  });

  it("秒より細かい桁は出さない", () => {
    // **読むための時刻**である——**ミリ秒は、人が突き合わせるのに要らない**
    expect(fetchedAtNote(new Date("2026-09-10T12:20:02.987Z"))).not.toContain("987");
  });
});
