import { describe, expect, it } from "vitest";
import type { TitledPullRequest } from "./title-overlap";
import { titleOverlapsFor } from "./title-overlap";

/** **タイトルを読めなかった PR は 0 件**。**既定値は置かない**ので、毎回渡す。 */
const NOTHING_UNREADABLE = 0;

function titled(number: number, title: string | undefined): TitledPullRequest {
  return { number, title };
}

describe("タイトルが同じ PR を並べる", () => {
  it("同じだった、いちばん長い並びを出す", () => {
    // **理由が追えないと、ルールベースである価値が無い**（#630 の完了条件）
    const reports = titleOverlapsFor(
      [titled(1, "リポジトリ一覧に上限を置く"), titled(2, "リポジトリ一覧に上限を置く（再）")],
      NOTHING_UNREADABLE,
    );

    expect(reports.get(1)?.match).toEqual({ number: 2, shared: "リポジトリ一覧に上限を置く" });
  });

  it("いちばん近い 1 本を選ぶ", () => {
    // **全部の組は出さない**——**かかりが本数の 2 乗 × 長さの 2 乗**になる
    const reports = titleOverlapsFor(
      [
        titled(1, "同じファイルを触る PR を出す"),
        titled(2, "同じファイルを触る PR"),
        titled(3, "同じファイル"),
      ],
      NOTHING_UNREADABLE,
    );

    expect(reports.get(1)?.match?.number).toBe(2);
  });

  it("同じくらい近いなら、番号の小さいほうを選ぶ", () => {
    const reports = titleOverlapsFor(
      [titled(1, "あいうえお"), titled(3, "あいうえ"), titled(2, "あいうえ")],
      NOTHING_UNREADABLE,
    );

    expect(reports.get(1)?.match?.number).toBe(2);
  });

  it("落とした相手の側からは、こちらが出る", () => {
    // **黙って消えない**——**同じ画面の別の行に出る**
    const reports = titleOverlapsFor(
      [
        titled(1, "同じファイルを触る PR を出す"),
        titled(2, "同じファイルを触る PR"),
        titled(3, "同じファイル"),
      ],
      NOTHING_UNREADABLE,
    );

    expect(reports.get(3)?.match?.number, "#3 の側からも組が見えない").toBe(1);
  });

  it("自分自身とは比べない", () => {
    expect(
      titleOverlapsFor([titled(1, "ひとつだけ")], NOTHING_UNREADABLE).get(1)?.match,
    ).toBeUndefined();
  });

  it("1 文字も同じでなければ、組にしない", () => {
    const reports = titleOverlapsFor(
      [titled(1, "あいうえお"), titled(2, "かきくけこ")],
      NOTHING_UNREADABLE,
    );

    expect(reports.get(1)?.match).toBeUndefined();
  });

  it("番号の飾りは、同じ並びとして数えない", () => {
    // **末尾の `（#123）` はほぼ全部の PR に付く**——**そこで一致しても、
    // 中身が似ていることにはならない**
    const reports = titleOverlapsFor(
      [titled(1, "あいうえお（#111）"), titled(2, "かきくけこ（#222）")],
      NOTHING_UNREADABLE,
    );

    expect(reports.get(1)?.match).toBeUndefined();
  });

  it("タイトルが読めていない PR は、似ていない側へ倒さない", () => {
    // **「読めなかった」を「似ていない」にしない**（#637 と同じ形）
    const reports = titleOverlapsFor(
      [titled(1, "あいうえお"), titled(2, undefined)],
      NOTHING_UNREADABLE,
    );

    expect(reports.get(1)?.match, "見えた範囲では同じ並びが無い").toBeUndefined();
    expect(reports.get(1)?.partial, "読めていない PR が居るのに下限と言っていない").toBe(true);
  });

  it("一覧から読めなかった PR が居れば、測り切れていないと言う", () => {
    // **候補にも現れない**（#637 の `invalid` と同じ）
    const reports = titleOverlapsFor([titled(1, "あいうえお"), titled(2, "かきくけこ")], 1);

    expect(reports.get(1)?.partial).toBe(true);
  });

  it("全部読めていれば、下限だとは言わない", () => {
    // **上の 2 つが空でないことを、ここが支えている**
    const reports = titleOverlapsFor(
      [titled(1, "あいうえお"), titled(2, "かきくけこ")],
      NOTHING_UNREADABLE,
    );

    expect(reports.get(1)?.partial).toBe(false);
  });

  it("訊いた PR は、組が無くても全部返る", () => {
    const reports = titleOverlapsFor(
      [titled(1, "あいうえお"), titled(2, "かきくけこ")],
      NOTHING_UNREADABLE,
    );

    expect([...reports.keys()].sort()).toEqual([1, 2]);
  });

  it("100 本・長いタイトルでも返る", () => {
    // **組は本数の 2 乗、1 組のかかりはタイトルの長さの 2 乗**である
    // ——**GitHub のタイトルは 256 文字が上限**なので、そこで測る。
    // **「遅い」を結論にしない**（#637 と同じ）——**上限を入れていないので、
    // 時間で赤くする根拠が無い。** **見るのは「組が消えていないこと」**である
    const many = Array.from({ length: 100 }, (_, index) =>
      titled(index + 1, `${"あ".repeat(200)}${index}${"い".repeat(55)}`),
    );

    const started = process.hrtime.bigint();
    const reports = titleOverlapsFor(many, NOTHING_UNREADABLE);
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;

    expect(reports.get(1)?.match, `100 本で ${elapsed} ms`).toBeDefined();
  });
});
