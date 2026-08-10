import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const PROCEDURES = [
  { role: "master", path: ".claude/commands/loop-master.md" },
  { role: "worker", path: ".claude/commands/loop-worker.md" },
] as const;

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/**
 * 「この周回はここで終わり」と書いてある箇所。**出口である。**
 *
 * **数を数えるのではなく、出口が 1 本に集まっていることを見る。**
 * 場面を並べる形に戻ると、経路が増えたときにまた漏れる。
 */
function exitCount(doc: string): number {
  return [...doc.matchAll(/この周回はここで終わり|何もせず終わる|この周回は終わり/g)].length;
}

describe("周回の出口", () => {
  it.each(PROCEDURES)("$role は出口で持ち手を決める", ({ role, path }) => {
    const doc = read(path);

    expect(doc).toContain("### 周回の出口");
    expect(doc).toContain(`bin/loop-handoff ${role}`);
  });

  it.each(PROCEDURES)("$role は出口の判断を手順書に書き写さない", ({ path }) => {
    // **判断はスクリプトが持つ。** 2 箇所に持つと、片方だけ直して食い違う
    const section = read(path).split("### 周回の出口")[1]?.split("\n## ")[0] ?? "";

    expect(section).not.toMatch(/changes-requested の PR があれば/);
    expect(section).not.toMatch(/backlog が/);
  });

  it.each(PROCEDURES)("$role の出口が複数あることを、手順書が前提にしている", ({ path }) => {
    // **出口は 1 つではない。** だからこそ「必ず通す」と書く必要がある。
    // ここが 1 つ以下になったら、出口の書き方が変わったということなので読み直す
    expect(exitCount(read(path))).toBeGreaterThan(1);
  });

  it.each(PROCEDURES)("$role の出口は、自分自身へ送ると読めない", ({ role, path }) => {
    // **`bin/loop-handoff` は自分自身を除く**ので、exit 0 で出るのは相手役だけである。
    // ここに自分の役を書くと、**書いてあるとおり実行して自分へ送ろうとする**
    // （**役の名前が逆**は文面だけで判定できる種類の誤りである）
    const section = read(path).split("### 周回の出口")[1]?.split("\n## ")[0] ?? "";
    const exitZero = section.split("- **exit 0**")[1]?.split("- **exit 1**")[0] ?? "";

    expect(exitZero).not.toContain(`\`${role}\``);
  });
});
