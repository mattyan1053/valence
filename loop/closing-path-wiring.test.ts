/**
 * **人しか判定できない完了条件が、判定されないまま閉じた**（#623）。
 *
 * **数えている場所と、止める場所が違った。** **数えていたのは周回の申し送り**
 * （**セッション間のメッセージ**）で、**止める場所は `Closes` によるマージ**である
 * ——**GitHub が自動で閉じるので、完了条件は誰も読まない。**
 *
 * **master が完了条件を読む経路は 1 本しかない**（マージの節の
 * `bin/loop-close-candidates` の枝）。**`Closes` が在ると、その経路を通らない。**
 *
 * **実測（2026-09-04）。** **閉じた Issue 301 件のうち 268 件が `Closes` で自動的に
 * 閉じ**、**そのうち 235 件が完了条件の節を持っていた**——**読む経路を通れたのは
 * 残り 33 件だけ**である。**#583 は 268 件目**で、**`awaiting-human` は
 * 一度も付いていない**（label の履歴で確認）ので、**閉じる側から見える印は無かった。**
 *
 * **倒す向きは「閉じ損ねる」側**である（`loop/close-issue-wiring.test.ts` と同じ）
 * ——**残れば誰かが見るが、誤って閉じると作業が消える。** **自動で閉じるのをやめ、
 * 全部を「読んでから閉じる」1 本へ寄せる。**
 */

import { describe, expect, it } from "vitest";
import { procedureText } from "./procedure-doc";

/**
 * GitHub が Issue を自動で閉じる語。
 *
 * **`Closes` だけを見ない**——**`Fixes` / `Resolves` も同じように閉じる**ので、
 * **1 語だけ禁じると、別の語で同じことが起きる。**
 */
const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#/i;

/** worker が PR を作る節。**本文に何を書くかは、ここが決めている**。 */
function prSection(): string {
  const doc = procedureText("worker");
  const from = doc.indexOf("### PR を作る");
  expect(from, "PR を作る節が無い").toBeGreaterThanOrEqual(0);
  return doc.slice(from).split("\n### ")[0] ?? "";
}

/** master がマージする節。**閉じるのはここである**（`loop/close-issue-wiring.test.ts` と同じ切り方）。 */
function mergeSection(): string {
  const doc = procedureText("master");
  const from = doc.indexOf("### exit 0 — マージする");
  expect(from, "マージの節が無い").toBeGreaterThanOrEqual(0);
  return doc.slice(from).split("\n### ")[0] ?? "";
}

describe("閉じる経路を 1 本にする", () => {
  it("PR の本文に、Issue を自動で閉じる語を書かせない", () => {
    // **これが #623 の主題である。** **書いた瞬間に、読む経路を通らなくなる。**
    //
    // **この節の散文に `Closes #` と並べても赤くなる。** **禁じているのは書式
    // そのもの**なので、**それでよい**——**理由を書くときは語だけを出し、
    // `#` を続けないこと。**
    expect(prSection(), "自動で閉じる語が残っている").not.toMatch(CLOSING_KEYWORD);
  });

  it("PR の本文から、その Issue を引けるようにさせる", () => {
    // **閉じる語を消すだけだと、`bin/loop-close-candidates` が候補を挙げられない**
    // ——**本文の `#N` を拾う口**なので、**番号そのものは本文に要る。**
    // **消す側を足したら、残る側の前提を見直す**（`AGENTS.md` §5）。
    expect(prSection(), "Issue 番号を本文へ書く指示が無い").toMatch(/Refs\s+#/);
  });

  it("マージしたあと、自動で閉じたことを前提にしない", () => {
    // **`closingIssuesReferences` は `Closes` が在るときしか埋まらない。**
    // **後始末をそこに繋いだままだと、毎回 0 件を読んで「片付いた」と見える。**
    expect(mergeSection(), "自動で閉じた前提の後始末が残っている").not.toContain(
      "closingIssuesReferences",
    );
  });

  it("閉じる前に、Issue のコメントも読む", () => {
    // **持ち越しの数が、閉じる側に届く**（#623 の完了条件）——**申し送りの文章に
    // 置くと届かない**ので、**Issue へ書き、閉じる側がそこを読む。**
    // **本文だけを読むと、持ち越したことは分からない。**
    const section = mergeSection();
    const from = section.indexOf("完了条件を読");
    expect(from, "完了条件を読む口が無い").toBeGreaterThanOrEqual(0);

    expect(section, "コメントを読む指示が無い").toMatch(/--comments/);
  });

  it("閉じないと決めたら、その Issue に人待ちの印を付ける", () => {
    // **止まらないことが分かる形で記録する**（#623 の完了条件）。
    // **`in-progress` のまま置くと、実装していないのに枠を食う**——
    // **`awaiting-human` は「人が外すまで待つ」で、作業が尽きた数にも入らない。**
    expect(mergeSection(), "人待ちへ倒す手が無い").toMatch(/--add-label\s+awaiting-human/);
  });
});
