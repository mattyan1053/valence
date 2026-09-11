import { describe, expect, it } from "vitest";
import {
  BALL_FILTERS,
  ballFilterLabel,
  ballFilterNote,
  ballFilterOf,
  CROSS_BALL_FILTERS,
} from "./ball-filter";

describe("誰の番かで絞る口", () => {
  it("並べたものだけを通す", () => {
    // **`?ball=` は URL に載っている**ので、**誰でも好きな文字列を入れられる**
    // （`approveNoticeKind` と同じ判断。#330）
    expect(ballFilterOf("author", BALL_FILTERS)).toBe("author");
    expect(ballFilterOf("いたずら", BALL_FILTERS), "並べていない値を通している").toBeUndefined();
  });

  it("出していない選択肢は受けない", () => {
    // **受ける値と、出す選択肢を 1 つの並びから作る** (#663)——**離すと、
    // 出していないものを URL で選べる**（**その逆も起きる**）
    expect(ballFilterOf("unknown", BALL_FILTERS), "画面に無い絞りを受けている").toBeUndefined();
  });

  it("同じ鍵が 2 つ載っていたら、絞らない", () => {
    // **`?ball=author&ball=merger` は配列で来る**——**片方を選ぶと、
    // URL と画面が食い違う**
    expect(ballFilterOf(["author", "merger"], BALL_FILTERS)).toBeUndefined();
  });

  it("絞っていなければ、何も言わない", () => {
    // **平常時に鳴るものは読まれなくなる**（#248）
    expect(ballFilterNote(undefined, { shown: 5, hidden: 0, undecided: 0 })).toBeUndefined();
  });

  it("絞っているときは、隠した件数を言う", () => {
    // **絞られていることに気づけるようにする**（#663）
    const note = ballFilterNote("author", { shown: 2, hidden: 3, undecided: 0 });

    expect(note).toContain("3 件");
    expect(note).toContain(ballFilterLabel("author"));
  });

  it("隠した件数が 0 でも、絞っていることは言う", () => {
    // **「全部が当てはまった」と「絞っていない」は違う**
    expect(ballFilterNote("author", { shown: 2, hidden: 0, undecided: 0 })).toContain(
      ballFilterLabel("author"),
    );
  });

  it("絞って 0 件になったら、0 件だと言う", () => {
    // **「絞って 0 件」と「1 件も無い」は違う**（#410 が `EmptyNotice` で塞いだ形）
    // ——**一覧が空のまま隠した件数だけ言っても、当てはまるものが無いのか
    // 読み落としたのか分からない**
    const note = ballFilterNote("author", { shown: 0, hidden: 4, undecided: 0 });

    expect(note, "0 件になったことを言っていない").toContain("ありません");
    expect(note, "隠した件数が消えている").toContain("4 件");
  });

  it("出す選択肢には、どれにも短い名前がある", () => {
    for (const ball of BALL_FILTERS) {
      expect(ballFilterLabel(ball), `${ball} の名前が無い`).not.toBe("");
    }
  });
});

/**
 * **読めていない範囲が残るなら、0 件と断定しない**（#694 のレビュー）。
 *
 * **#686 のレビューが盤面の空表示で塞いだのと同じ形**である——**「読めませんでした」
 * と言った直後に「ありません」と言うと、同じ画面が逆のことを言う。**
 * **読めなかった PR が、その番のものだったかもしれない。**
 */
describe("読めなかったものが残るとき", () => {
  it("絞って 0 件でも、無いとは言い切らない", () => {
    const note = ballFilterNote("author", { shown: 0, hidden: 4, undecided: 2 });

    expect(note, "読めていない範囲があるのに言い切っている").toContain("読めた範囲");
    expect(note, "隠した件数が消えている").toContain("4 件を隠しています");
  });

  it("読めなかったものが無ければ、これまでどおり言い切る", () => {
    // **平常時に断りを足すと読まれなくなる**（#248）——**言い切れるときは言い切る**
    const note = ballFilterNote("author", { shown: 0, hidden: 4, undecided: 0 });

    expect(note, "読めているのに限定している").not.toContain("読めた範囲");
  });

  it("通ったものがあるなら、限定しない", () => {
    // **限定が要るのは「無い」と言うときだけ**である
    const note = ballFilterNote("author", { shown: 2, hidden: 1, undecided: 3 });

    expect(note).not.toContain("読めた範囲");
  });
});

/**
 * **その画面が出せない絞りは、受けない**（#694 のレビュー 2 周目）。
 *
 * **受ける値と出す選択肢を 1 つの並びから作る**（#663 / #672 の線）——**離すと、
 * 画面に無い絞りを URL で選べる。** **並びが画面ごとに違うなら、渡す側も画面ごと**である。
 */
describe("画面ごとの並び", () => {
  it("横断の盤面は「マージする人の番」を出さない", () => {
    // **依存を跨がないので `block` を渡せず**、**`ballOf` は構造的に `merger` を
    // 返さない**（`ball.ts`）——**出しても必ず 0 件になる選択肢**である
    expect(CROSS_BALL_FILTERS).not.toContain("merger");
    expect(CROSS_BALL_FILTERS, "他の選択肢まで消えている").toContain("reviewer");
  });

  it("その画面に無い絞りは、URL からも受けない", () => {
    expect(ballFilterOf("merger", BALL_FILTERS), "盤面が受けられない").toBe("merger");
    expect(
      ballFilterOf("merger", CROSS_BALL_FILTERS),
      "画面に出していない絞りを URL で選べる",
    ).toBeUndefined();
  });
});
