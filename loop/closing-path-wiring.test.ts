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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { procedureText } from "./procedure-doc";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

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

/**
 * `bin/loop-unlisted-issues` が「一覧に出ている」と認める Issue の label。
 *
 * **写さずに読む**（`AGENTS.md` §5）——**片方だけ直すと、鳴る側と付ける側が食い違う。**
 */
function listedIssueLabels(): string[] {
  const script = readFileSync(join(REPO_ROOT, "bin/loop-unlisted-issues"), "utf8");
  const declaration = script.match(/LISTED_LABELS=\(([^)]*)\)/);
  expect(declaration?.[1], "一覧の label を宣言している場所が無い").toBeDefined();
  return (declaration?.[1] ?? "").trim().split(/\s+/);
}

/** 「閉じないと決めた」枝が Issue に足す label。**分けて打っても拾う。** */
function addedLabelsOfClosingBranch(): string[] {
  const section = mergeSection();
  const from = section.indexOf("閉じずに");
  expect(from, "閉じない側の枝が無い").toBeGreaterThanOrEqual(0);
  const block = section.slice(from).split("```")[1] ?? "";
  return [...block.matchAll(/--add-label\s+(\S+)/g)].map((match) => match[1] ?? "");
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

  it("マージする前に、その PR が閉じる Issue を見る", () => {
    // **worker の手順は、ループ外の著者には届かない**——**その PR に閉じる語が
    // 在れば、マージした瞬間に閉じる。** **`bin/loop-close-candidates` は closed を
    // 挙げない**ので、**閉じたあとでは読む経路へ入れない。**
    //
    // **見るのはマージの前で、1 回だけ**である。**後始末で読み直すと、
    // 自動で閉じない PR では毎回 0 件が返り**、**反映の遅い「さらう側」だけが残る。**
    // **`--json` の側だけを数える。** **1 行の中に `--jq '.closingIssuesReferences[]'`
    // も並ぶ**ので、**語で数えると 1 回の問い合わせが 2 と出る**（実際に外した）。
    const section = mergeSection();
    const looks = [...section.matchAll(/--json closingIssuesReferences/g)];
    expect(looks.length, "閉じる参照を見る場所が 1 つでない").toBe(1);

    const merge = section.indexOf("bin/loop-merge <");
    expect(merge, "マージする手が無い").toBeGreaterThanOrEqual(0);
    expect(looks[0]?.index ?? -1, "閉じる参照を見るのがマージより後になっている").toBeLessThan(
      merge,
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

  it("閉じないと決めたら、ループが触らない状態へ倒す", () => {
    // **止まらないことが分かる形で記録する**（#623 の完了条件）。
    // **`in-progress` のまま置くと、実装していないのに枠を食う。**
    expect(mergeSection(), "倒す先が無い").toMatch(/--add-label\s+blocked/);
  });

  it("倒した先の label が、Issue の一覧に出る", () => {
    // **`bin/loop-unlisted-issues` が一覧と認めない label だけを付けると、
    // 毎周回 `unlisted-issue:<N>` が積まれ、3 周で全ループが止まる**——
    // **今日、`waiting-condition` を単独で付けて実際に鳴っている。**
    //
    // **一覧の正はスクリプトが持つ**（`AGENTS.md` §5）。**ここに写すと、
    // あちらを直したときに片方だけ古くなる。**
    const listed = listedIssueLabels();
    expect(listed.length, "一覧と認める label を読み取れない").toBeGreaterThan(0);

    const added = addedLabelsOfClosingBranch();
    expect(added.length, "倒す先の label が読み取れない").toBeGreaterThan(0);
    expect(
      added.filter((label) => listed.includes(label)),
      `倒した先が一覧に出ない（付ける: ${added.join(",")} / 一覧: ${listed.join(",")}）`,
    ).not.toHaveLength(0);
  });
});
