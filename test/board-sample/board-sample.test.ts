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

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { renderBoardSample } from "./render";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** **書き出す先。** **`tmp/` は git が見ない**（`.gitignore`）。 */
const OUT = join(REPO_ROOT, "tmp/board-sample.html");

let html = "";

beforeAll(async () => {
  html = await renderBoardSample();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, html, "utf8");
}, 60_000);

/** **依存の一覧の中だけ**（**先頭の `<ol>` は推奨レビュー順**。`AGENTS.md` §4）。 */
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
    // **PR そのものを数える**——**見出しの番号は 1 本につき 1 つ**である。
    const numbers = new Set([...html.matchAll(/\/pull\/(\d+)"/g)].map(([, one]) => one));

    expect(numbers.size, "画面に出ている PR が 10 本に足りない").toBeGreaterThanOrEqual(10);
  });

  it("読めなかった・切れた・分からない の行も出る", () => {
    // **fixture が本物より狭くならないようにする**（#673 で踏んだ形）。
    // **揃っているものだけを並べると、いちばん読みにくい画面が出てこない**
    // ——**判定したいのは、まさにそこ**である。
    expect(html, "読めなかった PR が出ていない").toContain("読めなかった");
    expect(html, "時間内に返らなかった変更が出ていない").toContain("時間内に返りませんでした");
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

  it("CSS が焼き込まれていて、描いた class に当たっている", () => {
    // **開けば見られる**こと。**サーバもログインも要らない**のが、この材料の要点である。
    // **描いていない class の有無では見ない**——**`<style>` が在るだけなら空でも通る。**
    const style = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    const used =
      dependencyList(html)
        .match(/class="([^"]*)"/)?.[1]
        ?.split(/\s+/) ?? [];
    const first = used.find((one) => /^[a-z-]+$/.test(one));

    expect(first, "一覧に class が付いていない").toBeDefined();
    expect(style, `描いた class の規則が入っていない: ${first}`).toContain(`.${first}`);
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
