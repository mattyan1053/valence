import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 手直しの上限が決まっている場所（値のすぐ上に根拠を置く）。 */
function limitSection(): string {
  const gate = readFileSync(join(REPO_ROOT, "bin/loop-gate"), "utf8");
  const before = gate.split("readonly MAX_FIXUP_LINES=")[0] ?? "";
  // **直前のひとかたまり**だけを見る（他の節の記述で満たされないように）
  return before.split(/\n\n/).at(-1) ?? "";
}

/**
 * 手直しの上限に、失効した根拠が残っていないこと（#134）。
 *
 * **60 は「#36 の 44 行を通す / #41 の 74 行を止める」の中間**として決めた値だったが、
 * **#41 は後から「通してよかった」と分かっている**（#126。**4 件中 4 件で人の結論と
 * 食い違っていた**）。**上側の錨が外れたまま**だと、**次に「厳しすぎる / 緩すぎる」と
 * 言われたときに判断できない**。
 *
 * **書いてあることが根拠として通るか**を見る。**語があるかではない**——
 * **今日 3 回、「語はあるが主張が違う」で緑をすり抜けた**（#171 / #176 の 2 回）。
 */
describe("手直しの上限の根拠", () => {
  it("失効した錨が、根拠として残っていない", () => {
    // **`#41` を止めるための値**、はもう成り立たない。**触れてはいけないのではなく、
    // 「いまの根拠」として書かれていてはいけない**
    const section = limitSection();

    expect(section, "止める側の実例として #41 を挙げている").not.toMatch(
      /#41 の本体 \d+ 行を止める/,
    );
  });

  it("いまの数え方で測った実測が、根拠として書いてある", () => {
    // **#126 で数え方が変わっている**ので、**その前の実例は比較に使えない**
    // （89 行が同じ PR で 37 行になった）。**測り直した結果**が要る
    const section = limitSection();

    expect(section, "実測に基づく根拠が無い").toMatch(/いまの数え方で測った/);
    expect(section, "上限に触れた実例の有無が書かれていない").toMatch(/0 件/);
  });

  it("人の結論と master の判断を、分けて書いてある", () => {
    // **閾値を決めた側が、その閾値で下した判断を根拠にする**と、**独立した検証に
    // ならない**（master の指摘）。**「60 で困らなかった」と「60 が正しい」は別**である
    const section = limitSection();

    expect(section, "誰が判断したものかを分けていない").toMatch(/master が判断した/);
    expect(section, "独立した検証でないことが書かれていない").toMatch(/独立した検証/);
  });

  it("測り直しの手順が、そのまま走る形で残っている", () => {
    // **手で集めた表を残さない。** **同じ手順で数え直せること**が、この値を動かす条件。
    // **打つものが書いてあるか**を見る（散文で「測り直す」と書いてあるだけにしない）
    const section = limitSection();

    expect(section, "PR の並べ方が無い").toContain("gh pr list --state merged");
    expect(section, "数え方が無い").toContain("bin/loop-fixup-lines");
    expect(section, "レビュー済み head の取り方が無い").toContain("bin/loop-review-commits");
  });

  it("上側の錨に何が要るかが書いてある", () => {
    // **次に「厳しすぎる / 緩すぎる」と言われたときの出発点**である。
    // **何が足りないか**を書いていないと、**同じところからやり直すことになる**
    expect(limitSection(), "何があれば上限を動かせるのかが無い").toMatch(
      /人が「これは通すべきでなかった」と結論した実例/,
    );
  });
});
