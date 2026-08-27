/**
 * **`AGENTS.md` §5 の「窓を持つ記録」と「共有された記録がいつから効くか」の項**（#538）。
 *
 * **#537 は 3 往復かかった**——**2 つは「記録に行を足したことの副作用」**で、
 * **足した本人の diff には出てこない側**だった。**分かったことが PR 本文にしか無いと、
 * マージした時点で読まれなくなる**ので、**§5 へ移した。**
 *
 * **書いてあることと、それに沿って書かれていることは別である**（`agents-assertion-scope`
 * と同じ理由）——**項だけを切り出し**、**その語が本文の他に出ないことを数えてから**見る。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const AGENTS = fileURLToPath(new URL("./AGENTS.md", import.meta.url));

function agentsText(): string {
  return readFileSync(AGENTS, "utf8");
}

/**
 * §5 の中の、その語を含む箇条書き 1 つ。
 *
 * **見出しで切ってから取る**——**ファイル全体で見ると、§4 の「数える」のように、
 * 似た語を持つ段落が受けてしまう。**
 */
function itemWith(phrase: string): string {
  const text = agentsText();
  const section = text.slice(text.indexOf("\n## 5. ")).split("\n## ")[1] ?? "";
  const items = section.split("\n- ").filter((item) => item.includes(phrase));

  expect(items, `「${phrase}」を含む項が 1 つに絞れない`).toHaveLength(1);
  return items[0] ?? "";
}

/** **その語が、この項にしか無いことを数えてから見る**（§4 の但し書きそのもの）。 */
function expectOnlyIn(phrase: string, inside: string): void {
  const occurrences = agentsText().split(phrase).length - 1;

  expect(occurrences, `「${phrase}」は AGENTS.md に ${occurrences} 箇所ある`).toBe(1);
  expect(itemWith(inside), `「${phrase}」が §5 の項に無い`).toContain(phrase);
}

describe("AGENTS.md §5 — 窓を持つ記録", () => {
  it("何が押し出されるかを数える、と書いてある", () => {
    // **#537 の 2 周目**——**突かれたぶんが窓を埋め、直近の cron を押し出した。**
    // **`last_cron=-` は「一度も鳴っていない」と同じ顔**になる。
    expectOnlyIn("何が押し出されるかを数える", "何が押し出されるかを数える");
  });

  it("測り方（上限まで埋めてから 1 つ入れる）が書いてある", () => {
    // **埋めないと押し出しは起きない**——**「積んで数える」だけでは測れない**
    // （**1 周目の試験がそうだった**）。
    expectOnlyIn("窓を上限まで埋めてから", "何が押し出されるかを数える");
  });

  it("既にある「全行を数える読み手」の話と、別の面だと書いてある", () => {
    // **重ならないこと**が完了条件である——**あちらは「数えられてしまう」**、
    // **こちらは「押し出されてしまう」。**
    expect(itemWith("何が押し出されるかを数える"), "別の面であることが読めない").toContain(
      "押し出されてしまう",
    );
  });

  it("踏んだ回数と PR が書いてある", () => {
    // **§4 の項が「9 回踏んだ」と書いているのと同じ形**（#420 / #493）——
    // **数が入っているから効く。**
    const item = itemWith("何が押し出されるかを数える");

    expect(item, "踏んだ回数が無い").toContain("2 度踏んだ");
    expect(item, "どの PR で踏んだかが無い").toContain("#537");
  });
});

describe("AGENTS.md §5 — 共有された記録は、いつから効くか", () => {
  it("枝で走らせた瞬間から効く、と書いてある", () => {
    // **スクリプトと手順書の版ずれはマージするまで枝の中**だが、
    // **共通ディレクトリへ書く記録は違う**（#537 で実測）。
    expectOnlyIn("枝で走らせた瞬間から効く", "枝で走らせた瞬間から効く");
  });

  it("版ずれとの違いが書いてある", () => {
    // **「マージを待たない」が、この項の芯**である
    expect(itemWith("枝で走らせた瞬間から効く"), "版ずれとの違いが読めない").toContain(
      "マージを待たない",
    );
  });

  it("実測であることと、どの PR かが書いてある", () => {
    const item = itemWith("枝で走らせた瞬間から効く");

    expect(item, "実測だと読めない").toContain("実測");
    expect(item, "どの PR で見たかが無い").toContain("#537");
  });
});
