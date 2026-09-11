/**
 * **`AGENTS.md` §4 の「文字列で見る検査」の項**（#493）。
 *
 * **この項が言っていることを、この試験が守れていないと、何も言っていないのと同じ**
 * である——**項だけを切り出し**、**その語が本文の他に出ないことを数えてから**見る。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const AGENTS = fileURLToPath(new URL("./AGENTS.md", import.meta.url));

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

  it("書き終えたあとに、もう 1 度数えると書いてある", () => {
    // **数えたのに、あとから当たる相手が増える** (#689)——**当たる相手を、
    // 同じ変更の中で自分が足す**からである。**書いた時点では一意だった語が、
    // 書き終わるまでに一意でなくなる**（**実測で 1 日 8 件**）。
    expectOnlyInGuidance("書き終えたら、もう 1 度数える");
  });

  it("なぜ 2 回要るかが読める", () => {
    // **手だけを足しても、次に読む人は「前に数えたのに」で止まる**
    // ——**増える理由**（**自分で足す**）**が要る。**
    expectOnlyInGuidance("同じ変更の中で自分が足す");
  });

  it("変異が緑のままだったときの手が書いてある", () => {
    // **変異が何も言わないことがある** (#693。**2 件**)——**本物の材料に差が無いと、
    // 広い判定と狭い判定が同じ色になる。** **そこで止まると、「確かめた」だけが残る。**
    expectOnlyInGuidance("変異が緑のままなら、判定だけを取り出す");
  });

  it("なぜ材料越しでは測れないかが読める", () => {
    // **手だけを足しても、次に読む人は「変異を打ったのに」で止まる**
    // ——**出ない理由**（**材料の側に差が無い**）**が要る。**
    expectOnlyInGuidance("本物の材料に差が無い");
  });

  it("4 つ目が、いつ打つ手かが読める", () => {
    // **#689 が「3 つは別の手」と書いた理由は、4 つ目でも同じ**である
    // ——**どれがどの場面の手かが薄まると、並べた意味が消える。**
    // **4 つ目は変異の代わりではなく、変異が黙ったときの続き**である
    expectOnlyInGuidance("変異の代わりではない");
  });

  it("4 つの手が、それぞれどの場面かを並べている", () => {
    // **#693 の完了条件**——**4 つ目を足したら、どれがどの場面の手か読めること。**
    // **並べた 1 行を消しても、ほかの試験は緑のまま**だった（**変異で見つけた**）
    expectOnlyInGuidance("4 つは場面が違う");
    // **並べた 1 行だけを見る**——**項ごと見ると、同じ語が上の散文にも出ている**ので、
    // **一覧から消しても緑のまま**になる（**変異で踏んだ**。§4 のこの項そのものの形）
    const scenes = guidanceItem().slice(guidanceItem().indexOf("4 つは場面が違う"));
    for (const scene of [
      "当たる相手が居るか",
      "書いている間に増えていないか",
      "守りたい 1 行を消して赤くなるか",
      "変異が黙ったとき",
    ]) {
      expect(scenes, `「${scene}」が並んでいない`).toContain(scene);
    }
  });

  it("変異は、守りたい 1 行だけを消すと書いてある", () => {
    // **4 回とも変異は打たれていた** (#493)——**見つからなかったのは、消した範囲が
    // 判定の範囲より大きかったから**である（**節ごと消せば、どの試験も赤くなる**）。
    expectOnlyInGuidance("守りたい 1 行だけを消す");
  });
});
