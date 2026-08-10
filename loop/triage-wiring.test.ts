import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/** 上限に達した PR の行き先を決めている節。**文書全体で見ない。** */
function triageSection(): string {
  const section = read(".claude/commands/loop-master.md").split(
    "### 上限に達した PR をどこへ渡すか",
  )[1];
  if (section === undefined) {
    throw new Error("master の手順書に打ち切りの節がありません");
  }
  return section.split("\n## ")[0] ?? "";
}

function bashBlocks(section: string): string {
  return section
    .split("```bash")
    .slice(1)
    .map((chunk) => chunk.split("```")[0] ?? "")
    .join("\n");
}

describe("上限に達したあとの行き先", () => {
  it("手順書は判定をスクリプトに任せる", () => {
    // **散文で「小さいから」と書けるようにすると、都度判断が戻ってくる**（#73）
    expect(bashBlocks(triageSection())).toContain("bin/loop-triage");
  });

  it("手順書に閾値を書き写さない", () => {
    // **2 箇所に持つと片方だけ直して食い違う。** 60 も 5 もスクリプトが持つ
    expect(triageSection()).not.toMatch(/60 行/);
    expect(triageSection()).not.toMatch(/5 件/);
  });

  it("古い「優先度 1 / 2 が残るなら人へ渡す」が残っていない", () => {
    // **食い違いを残さない。** これが #73 の主題である
    const doc = read(".claude/commands/loop-master.md");

    expect(doc).not.toMatch(/優先度 1（正しさ）・2（セキュリティ）が残る/);
  });

  it("外出しするときに、後から当否を再判断できるものを残すと書いてある", () => {
    // **指摘の原文が無いと、読み返しても当否を判断できない**（#73 の完了条件）
    const section = triageSection();

    expect(section).toContain("deferred-finding");
    expect(section).toMatch(/原文/);
    expect(section).toMatch(/SHA/);
  });

  it("溜まりすぎたら人を呼ぶ経路がある", () => {
    // **既定をマージにする以上、歯止めはここにしかない**
    expect(bashBlocks(triageSection())).toContain("bin/loop-deferred-budget");

    const listed = execFileSync(join(REPO_ROOT, "bin/loop-stall"), ["--list"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    expect(listed).toContain("deferred-overflow");
    expect(triageSection()).toContain("deferred-overflow");
  });

  it("差し戻す側でも記録が残ると書いてある", () => {
    // **対応が来ないまま何周も回らない**こと（#73 の完了条件）
    expect(triageSection()).toContain("bin/loop-stall");
  });

  it("README は、これが交換であって改善ではないと書いている", () => {
    // **後から読む人がこれを改善だと誤読しないように。**
    // 誰も `deferred-finding` を読まなければ、単に品質が下がっただけになる
    const doc = read("loop/README.md");

    expect(doc).toMatch(/交換であって改善ではない/);
    expect(doc).toMatch(/deferred-finding/);
  });

  it("README と手順書で、同じことを別々に書いていない", () => {
    // **判定の順を 2 箇所に書かない**（#73 の完了条件）
    expect(read("loop/README.md")).not.toMatch(/入れる前より悪くなる/);
  });
});
