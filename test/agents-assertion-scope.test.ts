/**
 * **`AGENTS.md` §4 の「文字列で見る検査」の項**（#493）。
 *
 * **この項が言っていることを、この試験が守れていないと、何も言っていないのと同じ**
 * である——**項だけを切り出し**、**その語が本文の他に出ないことを数えてから**見る。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const AGENTS = fileURLToPath(new URL("../AGENTS.md", import.meta.url));

function agentsText(): string {
  return readFileSync(AGENTS, "utf8");
}

/**
 * §4 の中の、文字列で見る検査についての箇条書き 1 つ。
 *
 * **見出しで切ってから、その項だけを取る**——**ファイル全体で見ると、§5 の
 * 「残る側を数える」のように、似た語を持つ段落が受けてしまう。**
 */
function guidanceItem(): string {
  const text = agentsText();
  const section = text.slice(text.indexOf("\n## 4. ")).split("\n## ")[1] ?? "";
  const items = section.split("\n- ").filter((item) => item.includes("文字列で見る検査"));

  expect(items, "文字列で見る検査の項が 1 つに絞れない").toHaveLength(1);
  return items[0] ?? "";
}

/**
 * **その語が、この項にしか無いことを数えてから見る。**
 *
 * **「他にも出るか」は yes / no** だが、**数えると「どの行に当てたいのか」まで決まる**
 * ——**この項が言っている手そのもの**である。**書いてあることと、それに沿って
 * 書かれていることは別**なので、**ここは自分で踏まないようにする。**
 */
function expectOnlyInGuidance(phrase: string): void {
  const occurrences = agentsText().split(phrase).length - 1;

  expect(occurrences, `「${phrase}」は AGENTS.md に ${occurrences} 箇所ある`).toBe(1);
  expect(guidanceItem(), `「${phrase}」が §4 の項に無い`).toContain(phrase);
}

describe("AGENTS.md §4 — 文字列で見る検査", () => {
  it("書く前に、その語を持つ行を全部出すと書いてある", () => {
    // **4 回続けて踏んだのは「他にも出るか」を yes / no で見たから**である (#493)
    // ——**数えれば「5 行のうち、どれに当てたいのか」まで書く前に決まる。**
    expectOnlyInGuidance("その語を持つ行を全部出す");
  });

  it("変異は、守りたい 1 行だけを消すと書いてある", () => {
    // **4 回とも変異は打たれていた** (#493)——**見つからなかったのは、消した範囲が
    // 判定の範囲より大きかったから**である（**節ごと消せば、どの試験も赤くなる**）。
    expectOnlyInGuidance("守りたい 1 行だけを消す");
  });
});
