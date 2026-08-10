import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/** 着手を決めている節。**文書全体で見ない**——別の節の同じ言い回しで満たされる。 */
function claimSection(): string {
  const section = read(".claude/commands/loop-worker.md").split(
    "## 4. `ready` の 1 件を実装する",
  )[1];
  if (section === undefined) {
    throw new Error("worker の手順書に着手の節がありません");
  }
  return section.split("\n## ")[0] ?? "";
}

/** その節の bash ブロックだけ。**散文の言及では「実行している」ことにならない。** */
function bashBlocks(section: string): string {
  return section
    .split("```bash")
    .slice(1)
    .map((chunk) => chunk.split("```")[0] ?? "")
    .join("\n");
}

describe("着手の取り合い", () => {
  it("手順書は取り合いをスクリプトに任せる", () => {
    expect(bashBlocks(claimSection())).toContain("bin/loop-claim");
  });

  it("素の label 付け替えが残っていない", () => {
    // **これが本体。** 手順書に生の付け替えが残っていると、そちらを実行した周回だけが
    // 取り合いを起こす。**2 通りのやり方を並べない**
    expect(bashBlocks(claimSection())).not.toMatch(/gh issue edit[^\n]*--add-label in-progress/);
  });

  it("取れなかったときに待たないと書いてある", () => {
    // **待つと、そこが新しい詰まりどころになる**（#74 の lease と同じ判断）
    expect(claimSection()).toMatch(/待たない/);
  });

  it("exit の意味を、スクリプトの使い方と揃えている", () => {
    // **2 箇所に書くと片方だけ直して食い違う。** 使い方に出る語で手順書を書く
    const usage = execFileSync(
      "bash",
      ["-c", `"${join(REPO_ROOT, "bin/loop-claim")}" 2>&1 || true`],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
      },
    );
    const section = claimSection();

    expect(usage).toMatch(/exit 1[^\n]*次の Issue/);
    expect(section).toMatch(/exit 1[\s\S]{0,200}次の Issue/);
    expect(section).toMatch(/exit 2/);
  });
});
