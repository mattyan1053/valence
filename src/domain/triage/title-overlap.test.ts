import { describe, expect, it } from "vitest";
import type { TitledPullRequest } from "./title-overlap";
import { titleOverlapsFor } from "./title-overlap";

/** **タイトルを読めなかった PR は 0 件**。**既定値は置かない**ので、毎回渡す。 */
const NOTHING_UNREADABLE = 0;

/** **試験の既定**。**この長さ以上の一致は取りこぼさない**、が契約である。 */
const AT_LEAST = 3;

function titled(number: number, title: string | undefined): TitledPullRequest {
  return { number, title };
}

describe("タイトルが同じ PR を並べる", () => {
  it("同じだった、いちばん長い並びを出す", () => {
    // **理由が追えないと、ルールベースである価値が無い**（#630 の完了条件）
    const reports = titleOverlapsFor(
      [titled(1, "リポジトリ一覧に上限を置く"), titled(2, "リポジトリ一覧に上限を置く（再）")],
      AT_LEAST,
      NOTHING_UNREADABLE,
    );

    expect(reports.rows.get(1)).toEqual({ number: 2, shared: "リポジトリ一覧に上限を置く" });
  });

  it("いちばん近い 1 本を選ぶ", () => {
    // **全部の組は出さない**——**かかりが本数の 2 乗 × 長さの 2 乗**になる
    const reports = titleOverlapsFor(
      [
        titled(1, "同じファイルを触る PR を出す"),
        titled(2, "同じファイルを触る PR"),
        titled(3, "同じファイル"),
      ],
      AT_LEAST,
      NOTHING_UNREADABLE,
    );

    expect(reports.rows.get(1)?.number).toBe(2);
  });

  it("同じくらい近いなら、番号の小さいほうを選ぶ", () => {
    const reports = titleOverlapsFor(
      [titled(1, "あいうえお"), titled(3, "あいうえ"), titled(2, "あいうえ")],
      AT_LEAST,
      NOTHING_UNREADABLE,
    );

    expect(reports.rows.get(1)?.number).toBe(2);
  });

  it("落とした相手の側からは、こちらが出る", () => {
    // **黙って消えない**——**同じ画面の別の行に出る**
    const reports = titleOverlapsFor(
      [
        titled(1, "同じファイルを触る PR を出す"),
        titled(2, "同じファイルを触る PR"),
        titled(3, "同じファイル"),
      ],
      AT_LEAST,
      NOTHING_UNREADABLE,
    );

    expect(reports.rows.get(3)?.number, "#3 の側からも組が見えない").toBe(1);
  });

  it("自分自身とは比べない", () => {
    expect(
      titleOverlapsFor([titled(1, "ひとつだけ")], AT_LEAST, NOTHING_UNREADABLE).rows.get(1),
    ).toBeUndefined();
  });

  it("1 文字も同じでなければ、組にしない", () => {
    const reports = titleOverlapsFor(
      [titled(1, "あいうえお"), titled(2, "かきくけこ")],
      AT_LEAST,
      NOTHING_UNREADABLE,
    );

    expect(reports.rows.get(1)).toBeUndefined();
  });

  it("番号の飾りは、同じ並びとして数えない", () => {
    // **末尾の `（#123）` はほぼ全部の PR に付く**——**そこで一致しても、
    // 中身が似ていることにはならない**
    const reports = titleOverlapsFor(
      [titled(1, "あいうえお（#111）"), titled(2, "かきくけこ（#222）")],
      AT_LEAST,
      NOTHING_UNREADABLE,
    );

    expect(reports.rows.get(1)).toBeUndefined();
  });

  it("タイトルが読めていない PR は、似ていない側へ倒さない", () => {
    // **「読めなかった」を「似ていない」にしない**（#637 と同じ形）
    const reports = titleOverlapsFor(
      [titled(1, "あいうえお"), titled(2, undefined)],
      AT_LEAST,
      NOTHING_UNREADABLE,
    );

    expect(reports.rows.get(1), "見えた範囲では同じ並びが無い").toBeUndefined();
    expect(reports.partial, "読めていない PR が居るのに下限と言っていない").toBe(true);
  });

  it("一覧から読めなかった PR が居れば、測り切れていないと言う", () => {
    // **候補にも現れない**（#637 の `invalid` と同じ）
    const reports = titleOverlapsFor(
      [titled(1, "あいうえお"), titled(2, "かきくけこ")],
      AT_LEAST,
      1,
    );

    expect(reports.partial).toBe(true);
  });

  it("全部読めていれば、下限だとは言わない", () => {
    // **上の 2 つが空でないことを、ここが支えている**
    const reports = titleOverlapsFor(
      [titled(1, "あいうえお"), titled(2, "かきくけこ")],
      AT_LEAST,
      NOTHING_UNREADABLE,
    );

    expect(reports.partial).toBe(false);
  });

  it("同じ題の 2 本は、互いを選ぶ", () => {
    // **絞り込みが、境界を超えうる相手を落としてはいけない**（#653 のレビュー 2 周目）。
    // **`abca` と `abcabcabcabc` は bigram の「種類」が同じ**なので、
    // **種類数で選ぶと #1 が全員の相手になり**、**完全に同じ 2 本が互いを選ばない**
    // ——**この機能が拾うために作られた、まさにその場合に黙る**
    const reports = titleOverlapsFor(
      [titled(1, "abca"), titled(2, "abcabcabcabc"), titled(3, "abcabcabcabc")],
      AT_LEAST,
      NOTHING_UNREADABLE,
    );

    expect(reports.rows.get(2)?.number, "#2 が #3 を選んでいない").toBe(3);
    expect(reports.rows.get(3)?.number, "#3 が #2 を選んでいない").toBe(2);
    expect(reports.rows.get(2)?.shared).toBe("abcabcabcabc");
  });

  it("同じ文字が並ぶ題でも、取りこぼさない", () => {
    // **絞り込みは「種類」では上限にならない**（#653 のレビュー 2 周目）——
    // **`ああああああああああ` は 10 文字だが bigram は 1 種類**である。
    // **出現回数なら上限になる**（**長さ L の一致は、両方に L−1 個の出現を持つ**）
    const reports = titleOverlapsFor(
      [titled(1, "あ".repeat(10)), titled(2, "あ".repeat(10))],
      10,
      NOTHING_UNREADABLE,
    );

    expect(reports.rows.get(1)?.number, "種類で絞ると、ここで落ちる").toBe(2);
  });

  it("求めた長さに満たない一致は、組にしない", () => {
    // **境界の 1 つ下**（#630 の完了条件。**両側を置く**）
    const reports = titleOverlapsFor(
      [titled(1, "あいうABC"), titled(2, "かきくABC")],
      4,
      NOTHING_UNREADABLE,
    );

    expect(reports.rows.get(1)).toBeUndefined();
  });

  it("求めた長さちょうどの一致は、組にする", () => {
    // **境界のちょうど上**
    const reports = titleOverlapsFor(
      [titled(1, "あいうABC"), titled(2, "かきくABC")],
      3,
      NOTHING_UNREADABLE,
    );

    expect(reports.rows.get(1)?.shared).toBe("ABC");
  });

  it("絵文字は 1 文字として数える", () => {
    // **`String.length` は UTF-16 の数**（#653 のレビュー 2 周目）
    // ——**絵文字 1 個が 2 になり、境界を早く通る。**
    // **このリポジトリのタイトルは全部 gitmoji で始まる**ので、必ず踏む
    const reports = titleOverlapsFor(
      [titled(1, "✨🐛♻️"), titled(2, "✨🐛♻️")],
      4,
      NOTHING_UNREADABLE,
    );

    expect(reports.rows.get(1), "3 文字なのに 4 文字ぶんとして通っている").toBeUndefined();
  });

  it("訊いた PR は、組が無くても全部返る", () => {
    const reports = titleOverlapsFor(
      [titled(1, "あいうえお"), titled(2, "かきくけこ")],
      AT_LEAST,
      NOTHING_UNREADABLE,
    );

    expect([...reports.rows.keys()].sort()).toEqual([1, 2]);
  });

  /** **実物と同じくらい題がばらける 100 本**（**このリポジトリの分布**）。 */
  function realistic(): TitledPullRequest[] {
    const words = [
      "盤面",
      "依存",
      "レビュー",
      "記録",
      "停止",
      "経路",
      "境界",
      "判定",
      "材料",
      "一覧",
    ];
    const marks = ["✨", "🐛", "♻️", "📝"];
    return Array.from({ length: 100 }, (_, index) =>
      titled(
        index + 1,
        `${marks[index % 4]} ${words[index % 10]}を${words[(index * 3 + 1) % 10]}から${
          words[(index * 7 + 2) % 10]
        }へ${index}`,
      ),
    );
  }

  it("実物と同じ形の 100 本で、組が消えない", () => {
    // **絞り込みは「求めた長さに届かない相手」だけを落とす**（#653 のレビュー 2 周目）
    // ——**実物で測った**（このリポジトリの PR 100 本・4950 組）:
    // **共通する bigram の出現数が 9 以上の組は 16 組**だけ。
    //
    // **「遅い」を結論にしない**（#637 と同じ）——**見るのは「組が消えていないこと」**
    const many = realistic();
    const withDuplicate = [...many, titled(101, (many[0] as { title: string }).title)];

    const started = process.hrtime.bigint();
    const reports = titleOverlapsFor(withDuplicate, 10, NOTHING_UNREADABLE);
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;

    expect(reports.rows.get(101)?.number, `101 本で ${elapsed} ms`).toBe(1);
    expect(reports.partial, "測り切れているのに下限と言っている").toBe(false);
  });

  it("同じ題が並んでいても、返ってくる", () => {
    // **絞り込みが効かない側**（#653 のレビュー 3 周目）——**Dependabot は同じ題を
    // 並べる。** **盤面が開かないのは、行が 1 つ黙るのとは違う。**
    // **見るのは時間ではなく「返ってくること」と「`partial` が立つこと」**である
    const same = "⬆️ deps: bump the minor-and-patch group across 1 directory with 8 updates";
    const many = Array.from({ length: 100 }, (_, index) => titled(index + 1, same));

    const started = process.hrtime.bigint();
    const reports = titleOverlapsFor(many, 10, NOTHING_UNREADABLE);
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;

    expect(reports.rows.size, `100 本で ${elapsed} ms`).toBe(100);
    expect(reports.partial, "区切ったのに下限だと言っていない").toBe(true);
  });

  it("長すぎるタイトルは、先頭までしか比べない", () => {
    // **区切ったぶんは `partial` で言う**——**黙って切らない**
    const long = "あ".repeat(200);
    const reports = titleOverlapsFor([titled(1, long), titled(2, long)], 10, NOTHING_UNREADABLE);

    expect(reports.partial, "切ったのに下限だと言っていない").toBe(true);
  });

  it("符号単位ではなく、書記素の長さで選ぶ", () => {
    // **10 個の ASCII（10 単位・10 書記素）と 6 個の絵文字（12 単位・6 書記素）**
    // ——**符号単位で選ぶと後者が勝ち**、**書記素では 6 文字なので境界を通らず**、
    // **在るはずの 10 文字の一致が黙る**（#653 のレビュー 3 周目）
    const emoji = "🐛".repeat(6);
    const reports = titleOverlapsFor(
      [titled(1, `ABCDEFGHIJ-${emoji}`), titled(2, `${emoji}+ABCDEFGHIJ`)],
      10,
      NOTHING_UNREADABLE,
    );

    expect(reports.rows.get(1)?.shared).toBe("ABCDEFGHIJ");
  });

  it("壊れた文字列を返さない", () => {
    // **gitmoji の多くが上位サロゲート `D83D` を共有する**（`🐛` `🔥` `💄`）
    // ——**符号単位で切ると、共通部分が半端な符号単位で終わる**
    const reports = titleOverlapsFor(
      [titled(1, "同じ前置きがある題です🐛"), titled(2, "同じ前置きがある題です🔥")],
      10,
      NOTHING_UNREADABLE,
    );
    const shared = reports.rows.get(1)?.shared ?? "";

    expect(shared).toBe("同じ前置きがある題です");
    expect(
      [...shared].some((rune) => rune.charCodeAt(0) >= 0xd800 && rune.charCodeAt(0) <= 0xdbff),
    ).toBe(false);
  });
  it("絞り込みが多すぎるときは区切って、下限だと言う", () => {
    // **`COMPARISON_BUDGET` は正確な比較にしか掛からない**（#656）——**絞り込み
    // そのものが本数の 2 乗**である。**1 組も届かない盤面では、予算に 1 度も
    // 触れないまま、絞り込みだけが最後まで走る。**
    //
    // **求める長さを大きくして、その形を作る**——**どの組も届かない**ので、
    // **`COMPARISON_BUDGET` は 1 も減らない。**
    //
    // **実測**（このコンテナ、**索引を入れる前**）: **どの 2 本も 9 個の並びを
    // 共有しない 40 文字の題**で、**500 本 2.9 秒 / 1000 本 14.6 秒 / 2000 本 50 秒**
    // ——**上限のあった DP 側（最悪 0.6 秒）より 2 桁悪い。**
    //
    // **見るのは時間ではなく「返ってくること」と「`partial` が立つこと」**である
    // （#653 が決めた向き。**時間で赤くする根拠は、上限を決めてからしか無い**）。
    // **同じ 10 文字から作る**——**どの題もほぼ同じ並びを持つ**ので、
    // **索引の並びが長くなる**（**索引を入れても手数が減らない形**である）
    let state = 12345;
    const next = () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
    const alphabet = "あいうえおかきくけこ";
    const many = Array.from({ length: 200 }, (_, index) =>
      titled(
        index + 1,
        Array.from({ length: 100 }, () => alphabet[Math.floor(next() * 10)] as string).join(""),
      ),
    );

    const started = process.hrtime.bigint();
    const reports = titleOverlapsFor(many, 500, NOTHING_UNREADABLE);
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;

    expect(reports.rows.size, `200 本で ${elapsed} ms`).toBe(200);
    expect(reports.partial, "区切ったのに下限だと言っていない").toBe(true);
  });

  it("実物と同じ形の 100 本では、絞り込みを区切らない", () => {
    // **上限を低く置きすぎると、ふつうの盤面が毎回「下限です」になる**
    // ——**そちらの向きも測る**（#656 の完了条件）。
    // **このリポジトリの PR 100 本を数えた**: **題の長さは中央 21 文字・最大 54 文字**、
    // **索引を引く手数は合計 9,554**（**索引を引かないと 207,702**）。
    // **同じ形なら 1000 本でも 955,400 手で、上限に届かない。**
    const reports = titleOverlapsFor(realistic(), 10, NOTHING_UNREADABLE);

    expect(reports.partial, "測り切れているのに下限と言っている").toBe(false);
  });
  it("求める長さが 1 なら、並びを 1 つも共有しない相手も落とさない", () => {
    // **索引は「2 文字の並びを共有する相手」しか出さない**（#656）——**求める長さが
    // 1 のときは、並びを 1 つも共有しない相手にも 1 文字の一致がありうる。**
    // **落としてよいのは、求めた長さに届かない相手だけ**である（#653 のレビュー 2 周目）
    const reports = titleOverlapsFor([titled(1, "あい"), titled(2, "いう")], 1, NOTHING_UNREADABLE);

    expect(reports.rows.get(1)?.shared, "共有する並びが無い相手を落としている").toBe("い");
  });
});
