/**
 * **判定用の盤面が、作れていること**（#687）。
 *
 * **この試験は、材料を作る手でもある**——**通ると `tmp/board-sample.html` が
 * 出る。** **出来上がった HTML はコミットしない**（`AGENTS.md` §5）ので、
 * **置くのは作る手のほうである。**
 *
 * **見た目を「良くする」のはここではない**（#687）——**判定できる材料を
 * 作るところまで**である。**当否を言うのは人**であって、この試験ではない。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { classesIn, hasRule, layoutClasses, outputPath, renderBoardSample } from "./render";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * **書き出す先。** **頼まれたときだけ書く**（`./task board:sample` が渡す）。
 *
 * **黙って作業ツリーへ置かない** (#688 の実装で踏んだ)。**`./task check` が
 * 毎回ここを走る**ので、**置くと木が dirty になり**、**次の周回の冒頭が
 * `bin/loop-stall dirty` で止まる**——**3 周で `loop/STOP` が配られ、
 * 全ループが止まる。** **`.gitignore` は枝にしか無い**（**入るまで効かない**）
 * ので、**「無視されるから大丈夫」は、マージされるまで嘘**である（`AGENTS.md` §5）。
 *
 * **確かめるほうは、頼まれなくても毎回走る**——**材料が壊れたことには気づける。**
 */
const OUT = outputPath(process.env);

let html = "";

beforeAll(async () => {
  html = await renderBoardSample();
  if (OUT !== undefined) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, html, "utf8");
  }
}, 60_000);

/**
 * **規則の突き合わせそのものを見る** (#688 のレビュー 3 周目)。
 *
 * **盤面越しには測れない**——**いまの見本では、どの class にも規則が在る**ので、
 * **部分一致に戻しても緑のまま**だった（**変異を打って確かめた**）。
 * **落ちている規則が無い状態では、広い判定と狭い判定の差が出ない。**
 *
 * **差が出る形をここで作る**——**短い class の規則だけを落とす。**
 */
describe("CSS の規則の突き合わせ", () => {
  it("長いほうの class に当たらない", () => {
    // **`.flex` は `.flex-col` の一部**である——**部分一致だと、`.flex` の規則が
    // 丸ごと落ちても緑**になる
    expect(hasRule(".flex-col{display:flex}", "flex"), "`.flex-col` を `.flex` と読んだ").toBe(
      false,
    );
    expect(
      hasRule(".border-t{border-top:1px}", "border"),
      "`.border-t` を `.border` と読んだ",
    ).toBe(false);
  });

  it("その class の規則は見つける", () => {
    expect(hasRule(".flex{display:flex}", "flex")).toBe(true);
    // **区切りは `{` だけではない**——**まとめられた selector にも当たる**
    expect(hasRule(".flex, .grid{display:flex}", "flex")).toBe(true);
    expect(hasRule(".flex:hover{display:flex}", "flex")).toBe(true);
  });

  it("逃がした class も見つける", () => {
    // **`[` や `(` を含む class**（`AGENTS.md` の色は `var(--…)` で受ける）
    expect(hasRule(".bg-\\[var\\(--node-fill\\)\\]{background:red}", "bg-[var(--node-fill)]")).toBe(
      true,
    );
    expect(
      hasRule(".bg-\\[var\\(--node-stroke\\)\\]{background:red}", "bg-[var(--node-fill)]"),
    ).toBe(false);
  });
});

/**
 * **盤面の一覧の中だけ**（**先頭の `<ol>` は推奨レビュー順**。`AGENTS.md` §4）。
 *
 * **見出しから数える**——**先頭の `<ol>` を取ると、盤面が空でも推奨レビュー順の
 * 行に当たる**（**実際に一度そうなった**）。
 */
function dependencyList(markup: string): string {
  const heading = markup.indexOf("PR の依存");
  expect(heading, "依存の見出しが出ていない").toBeGreaterThanOrEqual(0);
  const from = markup.indexOf("<ol", heading);
  expect(from, "依存の一覧が出ていない").toBeGreaterThanOrEqual(0);
  return markup.slice(from, markup.indexOf("</ol>", from));
}

describe("判定用の盤面", () => {
  it("10 本以上が並んでいる", () => {
    // **#597 の完了条件がこれ**である。**実データでは 31.5 日で一度も並ばなかった**
    // （#678 で測った。最大 4 本）——**作らないと、この画面は出てこない。**
    //
    // **`<li>` を数えない**（`AGENTS.md` §4。**実際に 50 個あった**——**行ごとに
    // いくつも入るし、別の一覧も混ざる**ので、**行数を減らしても緑のままだった**）。
    //
    // **文書全体からも数えない** (#688 のレビュー 3 周目)——**先に描かれる
    // 推奨レビュー順が、同じ 12 件の `/pull/<番号>` を出す**（**数えた。見出しより
    // 前だけで 12 件**）ので、**盤面が 1 行も描かれなくても 10 件として通る。**
    // **確かめたいのは「10 本並んだ盤面」**なので、**盤面の一覧の中だけを数える。**
    const numbers = new Set(
      [...dependencyList(html).matchAll(/\/pull\/(\d+)"/g)].map(([, one]) => one),
    );

    expect(numbers.size, "盤面に並んでいる PR が 10 本に足りない").toBeGreaterThanOrEqual(10);
  });

  it("読めなかった・切れた・分からない の行も出る", () => {
    // **fixture が本物より狭くならないようにする**（#673 で踏んだ形）。
    // **揃っているものだけを並べると、いちばん読みにくい画面が出てこない**
    // ——**判定したいのは、まさにそこ**である。
    //
    // **「読めなかった」で見ない** (#688 のレビュー 2 周目)。**その語を持つ行は 5 つある**
    // （**読めなかった PR / 図に出ていないもの / 読めなかった issue / 振り先を読めなかった
    // issue / 振り先を読めなかった PR**）——**どれも別のもの**で、**材料の行を消しても
    // 別の行に当たって緑のまま**だった。**出る文言そのもの**（`changeUnavailableNote`）
    // **で見る**（**数えた。どれも 1 行ずつ**）。
    expect(html, "切れた材料の行が出ていない").toContain(
      "リスク判定の材料が、時間内に返りませんでした",
    );
    expect(html, "読めなかった材料の行が出ていない").toContain(
      "リスク判定の材料を読めませんでした",
    );
    expect(html, "読めなかった PR の断りが出ていない").toContain("読めなかった PR が");
    // **理由そのものは画面へ出さない**（`approvalDisplay` の但し書き。**値が入りうる**）
    // ——**出るのは札のほう**である
    expect(html, "承認の有無を読めなかった PR が出ていない").toContain(
      "承認の状態を取得できませんでした",
    );
  });

  it("実在の人とリポジトリが入っていない", () => {
    // **本物のログインを通った画面を残すと、人の名前が混ざる**（§6）
    // ——**盤面の各行が GitHub のログイン名をそのまま描く**（`assignment-note.ts`）。
    // **ここは作った材料だけ**である。
    expect(html, "実在の login が入っている").not.toContain("mattyan1053");
    expect(html, "作りものの持ち主が出ていない").toContain("sample-aoi");
    expect(html, "作りものの置き場所が出ていない").toContain("sample-org/sample-repo");
  });

  it("描いた class が、1 つ残らず CSS に入っている", () => {
    // **1 つ目だけを見ない** (#688 のレビュー 2 周目)。**先頭は `flex` のような
    // 素直な class** なので、**`[&_button]:min-w-24` や `bg-[var(--node-fill)]` が
    // 落ちても緑**だった——**実際に落ちていた**（**React が属性値を escape するので
    // `&amp;` のまま Tailwind へ渡り、規則が 1 つも出なかった**）。
    //
    // **見た目を目で判定するための材料**なので、**一部だけ素のままでも気づけないなら、
    // 材料として足りていない。**
    const style = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    const used = classesIn(html);
    const missing = used.filter((one) => !hasRule(style, one));

    expect(used.length, "class が集まっていない").toBeGreaterThan(20);
    expect(missing, `規則の無い class がある: ${missing.join(" ")}`).toEqual([]);
  });

  it("頼まれていなければ、作業ツリーへ置かない", () => {
    // **これを落とすと、ループが止まる** (#688 の実装で踏んだ)。**`./task check` が
    // 毎回この試験を走らせる**ので、**既定で書くと木が dirty になり**、**次の周回の
    // 冒頭が `bin/loop-stall dirty` で止まる**——**3 周で `loop/STOP`** である。
    expect(outputPath({}), "頼まれていないのに書き出す先がある").toBeUndefined();
    expect(outputPath({ BOARD_SAMPLE_OUT: "" }), "空の指定で書きに行く").toBeUndefined();
    expect(outputPath({ BOARD_SAMPLE_OUT: "tmp/x.html" })).toBe("tmp/x.html");
  });

  it("`./task board:sample` が、書き出す先を渡している", () => {
    // **渡す側が消えると、コマンドが何も出さなくなる**——**試験は緑のまま**である
    // （**書かない側が既定**なので）。**渡している行を名指しで見る**
    // （`AGENTS.md` §4。**この語を持つ行は `task` に 1 行しか無い**）。
    expect(readFileSync(join(REPO_ROOT, "task"), "utf8")).toContain("BOARD_SAMPLE_OUT=");
  });

  it("器が、本番のレイアウトと同じ class を持っている", async () => {
    // **見た目を目で判定するための 1 枚**なので、**器が違うと縦の伸び方と字の均しが
    // 変わる** (#688 のレビュー 3 周目。**`flex min-h-full flex-col` と
    // `h-full antialiased` が落ちていた**)。
    //
    // **`src/app/layout.tsx` から読んで突き合わせる**——**書き写すと、向こうが
    // 変わった日にここだけ古くなる**（`AGENTS.md` §5）。
    const layout = await layoutClasses();

    expect(html, `<html> の class が本番と違う: ${layout.html}`).toContain(
      `<html lang="ja" class="${layout.html}">`,
    );
    expect(html, `<body> の class に本番のものが無い: ${layout.body}`).toContain(
      `<body class="${layout.body} `,
    );
  });

  it("等幅の指定が、等幅の字に届く", () => {
    // **本番は `next/font` が変数を配る**が、**静止した 1 枚には配る人が居ない**
    // ——**未定義のまま `font-mono` を当てると `var()` が空になり、等幅でない字で
    // 描かれる**（**文字幅と折り返しが本番と変わる**。#688 のレビュー 3 周目）。
    const style = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    const mono = /--font-geist-mono:([^;]*)/.exec(style)?.[1] ?? "";

    expect(mono, "等幅の変数が定義されていない").not.toBe("");
    expect(mono, `等幅でない字に落ちる: ${mono}`).toContain("monospace");
    expect(style, "字面の変数が定義されていない").toContain("--font-geist-sans:");
  });

  it("盤面の色が、明と暗の両方で定義されている", () => {
    // **#583 の完了条件のうち、機械が見られる 1 つ。** **片方にしか無いと
    // `var()` は透明で描かれる**（`globals.css` の但し書き）。
    const style = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    const light = style.indexOf("--tier-risk");

    expect(light, "明のほうに色が無い").toBeGreaterThanOrEqual(0);
    expect(style.indexOf("--tier-risk", light + 1), "暗のほうに色が無い").toBeGreaterThan(light);
  });
});
