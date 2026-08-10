import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/** 使い方の正は**スクリプト**。手順書と README はそこへ寄せる。 */
function usage(): string {
  const result = execFileSync(
    "bash",
    ["-c", `"${join(REPO_ROOT, "bin/loop-lease")}" 2>&1 || true`],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  return result;
}

describe("lease の説明が実態と合っている", () => {
  it("使い方に、役ごとの取り方が書いてある", () => {
    // **`--list` 相当はここ。** 取り方が役で違うのに使い方が「役: master worker」だけだと、
    // **読んだ人は worker も 1 人だと思う**
    const text = usage();

    expect(text).toMatch(/worker[^\n]*作業場/);
    expect(text).toMatch(/master[^\n]*(役|1 人)/);
  });

  it("worker の手順書は「同じ作業場」で説明している", () => {
    // **嘘になった説明を残さない。** worker は作業場ごとに取るので、
    // 「同じ役の周回とは重ならない」は**別の作業場の worker とは重なる**という実態と食い違う
    const section =
      read(".claude/commands/loop-worker.md").split("### 通知を受け取ったら")[1] ?? "";

    expect(section).toContain("作業場");
    expect(section).not.toMatch(/同じ役の周回とは重ならない/);
  });

  it("master の手順書は「同じ役」のままである", () => {
    // **master は役のまま 1 人。** 判定が並列になるとゲートの意味が薄れる
    const section =
      read(".claude/commands/loop-master.md").split("### 通知を受け取ったら")[1] ?? "";

    expect(section).toMatch(/同じ役の周回とは重ならない/);
  });

  it("README は役によって単位が違うことを書いている", () => {
    // **「同じ役の周回は同時に走らない」だけだと worker で嘘になる**。
    // **lease を説明している段落そのものを見る**——文書全体を見ると、
    // 表の「作業場所」のような無関係な語で満たされる（実際に通ってしまった）
    const paragraph = read("loop/README.md")
      .split(/\n\s*\n/)
      .find((chunk) => chunk.includes("bin/loop-lease"));
    if (paragraph === undefined) {
      throw new Error("README が bin/loop-lease に触れていません");
    }

    expect(paragraph).toContain("作業場ごと");
    expect(paragraph).not.toMatch(/同じ役の周回は同時に走らない/);
  });

  it("スクリプトの語彙と手順書の語彙が一致している", () => {
    // **2 箇所に書くと片方だけ直して食い違う。** 使い方に出る語で手順書を書く
    const word = usage().includes("作業場");

    expect(word).toBe(true);
    expect(read(".claude/commands/loop-worker.md")).toContain("作業場");
  });
});
