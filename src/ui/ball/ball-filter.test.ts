import { describe, expect, it } from "vitest";
import { BALL_FILTERS, ballFilterLabel, ballFilterNote, ballFilterOf } from "./ball-filter";

describe("誰の番かで絞る口", () => {
  it("並べたものだけを通す", () => {
    // **`?ball=` は URL に載っている**ので、**誰でも好きな文字列を入れられる**
    // （`approveNoticeKind` と同じ判断。#330）
    expect(ballFilterOf("author")).toBe("author");
    expect(ballFilterOf("いたずら"), "並べていない値を通している").toBeUndefined();
  });

  it("出していない選択肢は受けない", () => {
    // **受ける値と、出す選択肢を 1 つの並びから作る** (#663)——**離すと、
    // 出していないものを URL で選べる**（**その逆も起きる**）
    expect(ballFilterOf("unknown"), "画面に無い絞りを受けている").toBeUndefined();
  });

  it("同じ鍵が 2 つ載っていたら、絞らない", () => {
    // **`?ball=author&ball=merger` は配列で来る**——**片方を選ぶと、
    // URL と画面が食い違う**
    expect(ballFilterOf(["author", "merger"])).toBeUndefined();
  });

  it("絞っていなければ、何も言わない", () => {
    // **平常時に鳴るものは読まれなくなる**（#248）
    expect(ballFilterNote(undefined, { shown: 5, hidden: 0 })).toBeUndefined();
  });

  it("絞っているときは、隠した件数を言う", () => {
    // **絞られていることに気づけるようにする**（#663）
    const note = ballFilterNote("author", { shown: 2, hidden: 3 });

    expect(note).toContain("3 件");
    expect(note).toContain(ballFilterLabel("author"));
  });

  it("隠した件数が 0 でも、絞っていることは言う", () => {
    // **「全部が当てはまった」と「絞っていない」は違う**
    expect(ballFilterNote("author", { shown: 2, hidden: 0 })).toContain(ballFilterLabel("author"));
  });

  it("絞って 0 件になったら、0 件だと言う", () => {
    // **「絞って 0 件」と「1 件も無い」は違う**（#410 が `EmptyNotice` で塞いだ形）
    // ——**一覧が空のまま隠した件数だけ言っても、当てはまるものが無いのか
    // 読み落としたのか分からない**
    const note = ballFilterNote("author", { shown: 0, hidden: 4 });

    expect(note, "0 件になったことを言っていない").toContain("ありません");
    expect(note, "隠した件数が消えている").toContain("4 件");
  });

  it("出す選択肢には、どれにも短い名前がある", () => {
    for (const ball of BALL_FILTERS) {
      expect(ballFilterLabel(ball), `${ball} の名前が無い`).not.toBe("");
    }
  });
});
