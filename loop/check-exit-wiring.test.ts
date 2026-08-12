import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TASK = join(REPO_ROOT, "task");
const PROCEDURE = ".claude/commands/loop-worker.md";

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/** `./task check` を走らせる bash ブロック（**打つところ**）。 */
function checkBlock(): string {
  const blocks = read(PROCEDURE)
    .split("```bash")
    .slice(1)
    .map((chunk) => chunk.split("```")[0] ?? "");
  return blocks.find((block) => block.includes("./task check >check.log")) ?? "";
}

/**
 * `./task check` を、**コンテナを起こさずに**走らせる。
 *
 * **見たいのは合否の伝え方**であって、検査の中身ではない——
 * `ensure_up` と `exec_app` を差し替える。
 */
function runCheck(exec: string, timeoutSec?: number): { status: number; stdout: string } {
  const body = [
    `source ${JSON.stringify(TASK)} >/dev/null 2>&1`,
    "ensure_up() { :; }",
    `exec_app() { ${exec}; }`,
    "cmd_check",
  ].join("; ");
  const command = timeoutSec === undefined ? ["-c", body] : ["-c", body];
  const result =
    timeoutSec === undefined
      ? spawnSync("bash", command, { encoding: "utf8" })
      : spawnSync("timeout", [`${timeoutSec}`, "bash", ...command], { encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout };
}

/**
 * `./task check` が殺されると、終了コードが無いまま出力が緑に見える（#147）。
 *
 * **実際に起きた**（2026-08-11、PR #142 の周回）——**ログはテストが緑で進む様子だけ**、
 * **終了コードは出ないまま push した**。**殺されたときの出力は、成功したときの出力の
 * 途中まで**なので、**目で見ると緑に見える**。
 *
 * **#121 が入れたのは「出力ではなく終了コードで決める」**で、
 * **「終了コードが存在しない」は守っていない**——**その隣の穴**である。
 *
 * **時間とともに踏みやすくなる。** 試験は増える一方で、**1 vCPU の VM** では
 * `./task check` が長くなり続ける——**長くなるほど、緑に見える確率が上がる**。
 *
 * **殺さないと 1 度も通らない。** **正常に終わる周回だけを見ると、
 * 何もしなくても緑**になる。
 */
describe("./task check の終わりの印", () => {
  it("走り終えたら、合否を最後の 1 行で言う", () => {
    const result = runCheck("return 0");

    expect(result.stdout, "終わりの印が出ていない").toContain("check-exit=0");
    expect(result.status, "終了コードを伝えていない").toBe(0);
  });

  it("落ちたときも、印と終了コードは合う", () => {
    // **印だけを見て緑と読ませない。** **印には合否が入っている**
    const result = runCheck("return 3");

    expect(result.stdout).toContain("check-exit=3");
    expect(result.status).toBe(3);
  });

  it("殺されたら、印が出ない", () => {
    // **これが本命である。** **本当に殺して**確かめる——**印が「全部走り終えた」ことを
    // 表しているか**は、**途中で殺しても最後の 1 行だけ出る形**にすると意味が無い
    const result = runCheck("sleep 30", 1);

    expect(result.stdout, "殺されたのに走り終えた顔をしている").not.toContain("check-exit");
    expect(result.status, "timeout に殺されていない").not.toBe(0);
  });

  it("手順書が、印と終了コードの両方を見る", () => {
    // **片方だけだと、片方の壊れ方をそのまま通す**（#147 の本文）。
    // **`status` が空でないこと**と**ログの末尾に印があること**の両方である。
    //
    // **散文ではなく、打つところで見る。** 節全体で見ると**表や説明に
    // `check-exit` があるだけで満たされ**、**ブロックから消しても緑のまま**になる
    // （#168 のレビュー 2 周目で踏んだ形——**書いたのに入っていない**）
    const block = checkBlock();

    expect(block, "終了コードを見ていない").toContain("status=$?");
    expect(block, "終わりの印を見ていない").toContain("check-exit");
  });

  it("「分からない」を「赤」と混ぜない", () => {
    // **どちらも push を止める必要は無いが、記録が違う**（#147 の完了条件）。
    // **押し通してよいが、押し通したと記録に残る**
    const section =
      read(PROCEDURE).split("### 実装は必ずテストファースト")[1]?.split("\n### ")[0] ?? "";
    const listed = spawnSync(join(REPO_ROOT, "bin/loop-stall"), ["--list"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).stdout;

    expect(section, "分からないときの記録が無い").toContain(
      'bin/loop-stall "local-ci-unknown:<Issue番号>"',
    );
    expect(listed, "識別子が一覧に無い").toContain("local-ci-unknown:<Issue番号>");
    expect(listed, "赤と同じ名前になっている").toContain("local-ci-failed:<PR番号>");
  });
});
