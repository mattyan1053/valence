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

  it("判定の分岐は「1 以外はすべて捨てる」になっている", () => {
    // **`exit 2` だけを並べると、並べ忘れた値が抜ける。** 判定器が消えた・
    // 実行できない（126 / 127）ときはどの分岐にも入らず、
    // **「判定不能なら捨てる」が成立しない**（実際に踏んだ）。
    //
    // **節を切って見る。** 文書全体を見ると、別の節の同じ言い回しが拾われて
    // **分岐を書き換えても通る**（実際に 0 件だった）
    const section = read(".claude/commands/loop-master.md")
      .split("### 1.1 手順とスクリプトを最新にする")[1]
      ?.split("\n## ")[0];

    expect(section).toMatch(/1 以外/);
    expect(section).toMatch(/126 \/ 127/);
  });

  it("マージした周回も、変わっていなければ続ける", () => {
    // **ここで終えると、次の周回まで誰も動かない。** マージでは通知を送らないので、
    // worker は自分の cron が来るまで何も知らない
    const doc = read(".claude/commands/loop-master.md");
    const afterMerge = doc.split("### exit 0 — マージする")[1]?.split("\n### ")[0] ?? "";

    expect(afterMerge).toContain("bin/loop-procedure-changed");
    expect(afterMerge).toMatch(/ステップ 6/);
    // **比較の右辺がマージ後の状態になっていること。** 手元の HEAD は
    // マージでは動かないので、取り直さずに比べると必ず「変わっていない」になる
    expect(afterMerge).toContain("git fetch origin main");
    expect(afterMerge).toMatch(/bin\/loop-procedure-changed [^\n]+ FETCH_HEAD/);
  });
});
