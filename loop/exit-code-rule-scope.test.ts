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

/**
 * **規則を言い直している行**（規則の中も外も、まとめて数える）。
 *
 * **語を 1 つに絞らない**（#701 のレビュー）——**「パイプ」だけを見ていたら、
 * 「後ろに別のコマンドを置くと `$?` が上書きされる」が 5 件目として残っていた。**
 *
 * **散文は `$?` をバッククォートで書く**（**打つ行は `case "$?" in` のように裸**）
 * ——**数えたら、バッククォート付きは規則の語彙にしか出てこない。**
 */
function restatementLines(text: string): readonly string[] {
  return text
    .split("\n")
    .filter(
      (line) => line.includes("`$?`") || line.includes("PIPESTATUS") || line.includes("パイプ"),
    );
}

/** **バッククォートで囲まれた語**（道具の例は、必ずこの形で書かれる）。 */
function quoted(text: string): readonly string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
}

describe.each(ROLES)("%s は、終了コードの規則を 1 箇所で読む", (role) => {
  it("規則がある", () => {
    const occurrences = procedureText(role).split(ANCHOR).length - 1;
    expect(occurrences, "規則の行の数").toBe(1);
  });

  it("道具の例を持たない", () => {
    // **例に結びつけると、読む側はその道具の話として畳む**（#700 の観測そのもの）
    // **並べて比べる**（#701 のレビュー）——**道具の名前を並べると、並べ損ねたものが通る**
    expect([...quoted(ruleSection(role))].sort(), "規則の段落に居る語").toEqual([
      "$?",
      "${PIPESTATUS[0]}",
      "0",
    ]);
  });

  it("繋ぎたいときの逃げ道が残っている", () => {
    // **繋ぐ場面は在る**——**禁止ではなく、見る先を言う**
    expect(ruleSection(role), "逃げ道が無い").toContain("${PIPESTATUS[0]}");
  });

  it("言い直しが、規則の外に無い", () => {
    // **足すほど畳まれる**ので、**例つきの言い直しを 4 箇所に残さない**
    const outside = restatementLines(procedureText(role)).filter(
      (line) => !restatementLines(ruleSection(role)).includes(line),
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
  it("言い直しを、語を変えられても拾う", () => {
    // **当たる入力と当たらない入力を隣どうしに置く**（`AGENTS.md` §4）
    expect(restatementLines("**後ろに別のコマンドを置くと `$?` が上書きされる**")).toHaveLength(1);
    expect(restatementLines("繋ぐなら `${PIPESTATUS[0]}` を見る")).toHaveLength(1);
    expect(restatementLines("パイプで繋ぐと")).toHaveLength(1);
  });

  it("打つ行は拾わない", () => {
    // **裸の `$?` は、正しく受けている行**である
    expect(restatementLines('case "$?" in')).toEqual([]);
    expect(restatementLines('./task check >"$log" 2>&1; status=$?')).toEqual([]);
  });

  it("道具の名前は、バッククォートごと拾う", () => {
    expect(quoted("**`cut` の値になる**")).toEqual(["cut"]);
    expect(quoted("例を持たない")).toEqual([]);
  });
});
