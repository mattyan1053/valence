import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/** 対象の一覧の正は **スクリプト**。手順書に書き写さない。 */
function watched(): string[] {
  return execFileSync(join(REPO_ROOT, "bin/loop-procedure-changed"), ["--list"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => line !== "");
}

/**
 * master の手順書が**実行している**もの。
 *
 * **読むだけのものは数えない。** `loop/STOP` は状態であって手順ではなく、
 * 入れ替わっても master の実行内容は変わらない（毎周回そこを見るだけである）。
 */
function executedByMaster(): string[] {
  const doc = read(".claude/commands/loop-master.md");
  const found = [...doc.matchAll(/(?:^|[\s`(])((?:bin|src|scripts)\/[\w./-]+|\.\/task)/gm)]
    .map((match) => match[1] ?? "")
    .map((path) => (path === "./task" ? "task" : path));
  return [...new Set(found)];
}

describe("周回を捨てるかの判定", () => {
  it("手順書は判定をスクリプトに任せる", () => {
    expect(read(".claude/commands/loop-master.md")).toContain("bin/loop-procedure-changed");
  });

  it("手順書に対象の一覧を書き写さない", () => {
    // **2 箇所に持つと、ファイルが増えたときに片方だけ直して食い違う**
    const doc = read(".claude/commands/loop-master.md");
    const listed = watched().filter((path) => path.endsWith("/") && doc.includes(`\`${path}\``));

    expect(listed).toEqual([]);
  });

  it("master が実行するものが、すべて対象に入っている", () => {
    // **一覧が実体からずれたら気づける。** master が新しい場所のものを実行し始めても、
    // 対象に入っていなければ**入れ替わったのに走り続ける**
    const uncovered = executedByMaster().filter(
      (path) => !watched().some((target) => path === target || path.startsWith(target)),
    );

    expect(uncovered).toEqual([]);
  });
});
