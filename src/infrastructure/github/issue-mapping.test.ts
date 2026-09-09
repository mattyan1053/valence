import { describe, expect, it } from "vitest";
import { toIssueListing } from "./issue-mapping";

const ISSUE = {
  number: 1,
  title: "落ちる",
  assignees: [{ login: "someone" }],
  user: { login: "someone", type: "User" },
};

describe("toIssueListing", () => {
  it("実データの形から一覧を組み立てる", () => {
    const listing = toIssueListing([ISSUE]);

    expect(listing.issues).toEqual([{ number: 1, title: "落ちる" }]);
    expect(listing.assignments.get(1)).toEqual({ assignees: ["someone"], authoredByBot: false });
    expect(listing.invalid).toEqual([]);
  });

  it("PR を issue として並べない", () => {
    // **`GET /issues` は PR も返す**（GitHub では PR も issue である）
    // ——**混ぜると、盤面に同じ番号の行が 2 度出る**
    const listing = toIssueListing([{ ...ISSUE, number: 2, pull_request: { url: "..." } }, ISSUE]);

    expect(listing.issues.map((issue) => issue.number)).toEqual([1]);
  });

  it("PR を、読めなかったものとして数えない", () => {
    // **「issue ではない」と「読めなかった」は別**である
    const listing = toIssueListing([{ ...ISSUE, pull_request: { url: "..." } }]);

    expect(listing.invalid).toEqual([]);
  });

  it("読めなかった 1 件で、他の issue を捨てない", () => {
    const listing = toIssueListing([{ title: "番号が無い" }, ISSUE]);

    expect(listing.issues.map((issue) => issue.number)).toEqual([1]);
    expect(
      listing.invalid.map((entry) => entry.index),
      "応答の位置で示す",
    ).toEqual([0]);
    expect(listing.invalid[0]?.reason).not.toBe("");
  });

  it("bot が立てたものを、そう記録する", () => {
    const listing = toIssueListing([
      { ...ISSUE, assignees: [], user: { login: "dependabot[bot]", type: "Bot" } },
    ]);

    expect(listing.assignments.get(1)).toEqual({ assignees: [], authoredByBot: true });
  });

  it("assignee が読めなくても、issue は並べる", () => {
    // **1 件の形が違うだけで盤面全部を捨てない**（`merge-status-mapping` と同じ形）
    // ——**アサインだけ落とし、行は残す**
    const listing = toIssueListing([{ ...ISSUE, assignees: "?" }]);

    expect(listing.issues).toEqual([{ number: 1, title: "落ちる" }]);
    expect(listing.assignments.has(1), "読めていないのにアサインを持っている").toBe(false);
  });

  it("立てた人が読めなくても、issue は並べる", () => {
    const listing = toIssueListing([{ ...ISSUE, user: null }]);

    expect(listing.issues).toEqual([{ number: 1, title: "落ちる" }]);
    expect(listing.assignments.has(1)).toBe(false);
  });

  it("タイトルが空なら、読めなかった側へ倒す", () => {
    // **空文字を残すと、表示の側で「短いタイトル」と「取れなかった」が
    // 見分けられない**（`pull-request-mapping` と同じ判断）
    const listing = toIssueListing([{ ...ISSUE, title: "" }]);

    expect(listing.issues).toEqual([]);
    expect(listing.invalid.map((entry) => entry.index)).toEqual([0]);
  });
});
