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
import { classesIn, outputPath, renderBoardSample, selectorFor } from "./render";

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

describe("判定用の盤面", () => {
  it("10 本以上が並んでいる", () => {
    // **#597 の完了条件がこれ**である。**実データでは 31.5 日で一度も並ばなかった**
    // （#678 で測った。最大 4 本）——**作らないと、この画面は出てこない。**
    //
    // **`<li>` を数えない**（`AGENTS.md` §4。**実際に 50 個あった**——**行ごとに
    // いくつも入るし、別の一覧も混ざる**ので、**行数を減らしても緑のままだった**）。
    // **PR そのものを数える**——**見出しの番号は 1 本につき 1 つ**である。
    const numbers = new Set([...html.matchAll(/\/pull\/(\d+)"/g)].map(([, one]) => one));

    expect(numbers.size, "画面に出ている PR が 10 本に足りない").toBeGreaterThanOrEqual(10);
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
    const missing = used.filter((one) => !style.includes(selectorFor(one)));

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

  it("盤面の色が、明と暗の両方で定義されている", () => {
    // **#583 の完了条件のうち、機械が見られる 1 つ。** **片方にしか無いと
    // `var()` は透明で描かれる**（`globals.css` の但し書き）。
    const style = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    const light = style.indexOf("--tier-risk");

    expect(light, "明のほうに色が無い").toBeGreaterThanOrEqual(0);
    expect(style.indexOf("--tier-risk", light + 1), "暗のほうに色が無い").toBeGreaterThan(light);
  });
});
