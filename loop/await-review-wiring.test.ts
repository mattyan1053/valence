import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function master(): string {
  return readFileSync(join(REPO_ROOT, ".claude/commands/loop-master.md"), "utf8");
}

/** 3.2（レビューを要求してよいか確かめる）の節だけを取り出す。 */
function reviewBudgetSection(): string {
  const section = master().split("### 3.2 レビューを要求してよいか確かめる")[1];
  if (section === undefined) {
    throw new Error("loop-master.md に 3.2 の節がありません");
  }
  return section.split("\n### ")[0] ?? "";
}

/**
 * 経路ごとに切り出す。**節全体を見ると、片方の配線を外しても
 * もう片方が拾ってしまい、変異を捕まえられない**（実際に 0 件だった）。
 *
 * **終端も要る。** 次のトップレベルの分岐で切らないと、**その経路の中身を消しても
 * 後ろの分岐が拾って通る**（これも実際に 0 件だった）。
 */
function pathSegment(path: "exit 0" | "exit 3"): string {
  const section = reviewBudgetSection();
  const branches = [...section.matchAll(/^- exit \d+ →/gm)];
  const start = branches.findIndex((branch) => branch[0].startsWith(`- ${path} →`));
  if (start < 0) {
    throw new Error(`3.2 に「${path}」の分岐がありません`);
  }
  const from = branches[start]?.index ?? 0;
  const to = branches[start + 1]?.index ?? section.length;
  return section.slice(from, to);
}

/** 3.2 のうち、最初の分岐より前（判定を回す前）の部分。 */
function beforeBudget(): string {
  const section = reviewBudgetSection();
  const firstBranch = section.search(/^- exit \d+ →/m);
  return firstBranch < 0 ? section : section.slice(0, firstBranch);
}

describe("レビューの到着を待つ配線", () => {
  it.each(["exit 0", "exit 3"] as const)("%s の経路で待つ", (path) => {
    // **初回レビューは Codex が自動で走らせる**ので master は要求せず exit 3 になる。
    // そちらに配線が無いと、**すべての PR で初回レビューだけ誰も待っていない**。
    //
    // **名前が出てくるだけでは足りない。** 結果の説明にも名前は出るので、
    // それを数えると**呼び出しを消しても通る**（実際に 0 件だった）。
    // **実際に呼んでいる行**を見る
    expect(pathSegment(path)).toMatch(/^\s*bin\/loop-await-review <PR番号>/m);
  });

  it.each(["exit 0", "exit 3"] as const)(
    "%s の経路で、待機より長いタイムアウトを指定することが書いてある",
    (path) => {
      // **シェルの既定タイムアウトは待機の上限より短い。** 指定を書き忘れると
      // **待機は必ず途中で殺され、しかも何も報告されない**（実測で 2 分で死んだ）。
      // 症状は「待つ仕組みが入る前」と同じなので、効いていないことに気づけない
      expect(pathSegment(path)).toContain("LOOP_AWAIT_REVIEW_MAX_SEC");
      expect(pathSegment(path)).toMatch(/timeout/);
    },
  );

  it("基準は判定より前に取る", () => {
    // **判定と基準取得の間に届いたレビューを、自分で基準にしてしまう。**
    // そのぶんを「新しい」と読めなくなり、**待つようにしたのに何も拾わない**
    expect(beforeBudget()).toMatch(/if ! \w+="\$\(bin\/loop-review-commits/);
    expect(beforeBudget()).toContain('bin/loop-stall "review-budget-unknown:');
  });

  it.each(["exit 0", "exit 3"] as const)("%s の経路は、先に取った基準を使う", (path) => {
    // **パイプに繋いで取り直さない。** 終了コードが `cut` のものになり、
    // 取得の失敗が「レビューが 1 件も無い」に化ける（#76 で 1 度直した形）
    expect(pathSegment(path)).toMatch(/bin\/loop-await-review <PR番号> "\$since"/);
    expect(pathSegment(path)).not.toMatch(/bin\/loop-review-commits[^\n]*\|/);
  });
});
