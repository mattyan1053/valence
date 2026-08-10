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
 */
function pathSegment(path: "exit 0" | "exit 3"): string {
  const section = reviewBudgetSection();
  const start = section.indexOf(`- ${path} →`);
  if (start < 0) {
    throw new Error(`3.2 に「${path}」の分岐がありません`);
  }
  const rest = section.slice(start + 1);
  const end = rest.indexOf("- exit 3 →");
  return path === "exit 0" && end >= 0 ? rest.slice(0, end) : rest;
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
});
