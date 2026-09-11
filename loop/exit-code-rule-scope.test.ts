/**
 * **終了コードは、打ったコマンドのもの**（#700）。
 *
 * **規則は既に手順書へ書いてあった**——**ただし 4 箇所とも、道具の例に結びついた形**
 * である（`./task check` の合否／`gh pr list` の件数／`cut` の値）。**それでも、
 * 同じ日に 2 つの作業場が、どちらもその例には無い道具で踏んだ**
 * （`bin/loop-claim resume` と `bin/loop-review-reply`。**どちらも `| tail` の `$?`**）。
 *
 * **踏んだ人の読みが、いちばん重い**——**「`./task check` の話として読んでいて、
 * 同じことが別の道具にも起きるとは思っていなかった」。** **読む側は、例のほうを
 * 規則として畳む。**
 *
 * **だから、例を足して守らない。** **例を持たない 1 箇所に置き、言い直しを増やさない。**
 */

import { describe, expect, it } from "vitest";
import { type LoopRole, procedureText } from "./procedure-doc";

const ROLES: readonly LoopRole[] = ["master", "worker"];

/**
 * **規則の 1 行目。**
 *
 * **節を作っていない**——**手順書は長い**ので、**足すのは数行**にする（#689 / #700）。
 */
const ANCHOR = "**終了コードは、打ったコマンドのもの**";

/** **規則の段落**（その行の頭から、次の空行まで）。 */
function ruleSection(role: LoopRole): string {
  const text = procedureText(role);
  const at = text.indexOf(ANCHOR);
  if (at === -1) {
    return "";
  }
  // **行の頭から取る**——**途中で切ると、同じ行が「規則の外」にも見える**
  return text.slice(text.lastIndexOf("\n", at) + 1).split("\n\n")[0] ?? "";
}

/** **「パイプ」を語る行**（規則の中も外も、まとめて数える）。 */
function pipeLines(text: string): readonly string[] {
  return text.split("\n").filter((line) => line.includes("パイプ"));
}

describe.each(ROLES)("%s は、終了コードの規則を 1 箇所で読む", (role) => {
  it("規則がある", () => {
    const occurrences = procedureText(role).split(ANCHOR).length - 1;
    expect(occurrences, "規則の行の数").toBe(1);
  });

  it("道具の例を持たない", () => {
    // **例に結びつけると、読む側はその道具の話として畳む**（#700 の観測そのもの）
    const examples = ruleSection(role)
      .split("\n")
      .filter((line) => /\.\/task|gh |bin\//.test(line));
    expect(examples, "規則の節に道具の例が居る").toEqual([]);
  });

  it("繋ぎたいときの逃げ道が残っている", () => {
    // **繋ぐ場面は在る**——**禁止ではなく、見る先を言う**
    expect(ruleSection(role), "逃げ道が無い").toContain("${PIPESTATUS[0]}");
  });

  it("言い直しが、規則の外に無い", () => {
    // **足すほど畳まれる**ので、**例つきの言い直しを 4 箇所に残さない**
    const outside = pipeLines(procedureText(role)).filter(
      (line) => !pipeLines(ruleSection(role)).includes(line),
    );
    expect(outside, "規則の外で言い直している").toEqual([]);
  });
});

describe("役をまたいで同じ文面である", () => {
  it("master と worker で、規則の節が 1 字も違わない", () => {
    // **2 つのファイルに同じ節を置く**ので、**片方だけ直ると食い違う**
    expect(ruleSection("worker")).toBe(ruleSection("master"));
  });
});

describe("数える手そのもの", () => {
  it("「パイプ」を語る行だけを拾う", () => {
    expect(pipeLines("パイプで繋ぐと\n先に変数へ受ける\n| tail -1")).toEqual(["パイプで繋ぐと"]);
  });
});
