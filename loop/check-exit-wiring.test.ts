import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TASK = join(REPO_ROOT, "task");
const PROCEDURE = ".claude/commands/loop-worker.md";

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/** 節ごとの bash ブロック。 */
function blocks(): { section: string; body: string }[] {
  const found: { section: string; body: string }[] = [];
  let section = "";
  let body: string[] | undefined;
  for (const line of read(PROCEDURE).split("\n")) {
    if (/^#{2,4} /.test(line)) {
      section = line.trim();
    }
    if (line.startsWith("```")) {
      if (body !== undefined) {
        found.push({ section, body: body.join("\n") });
      }
      body = line.startsWith("```bash") ? [] : undefined;
      continue;
    }
    body?.push(line);
  }
  return found;
}

/**
 * **`./task check` を打つブロックを、全部並べる。**
 *
 * **1 つだけ返さない。** `find` で 1 つ取ると**名指しと同じ**になり、
 * **打つところが増えても気づけない**——**#166 / #168 と同じ形を 3 回続けて踏んだ**
 * （直した場所の隣が抜ける）。**「打つところで見る」に直しても、
 * 「打つところが 1 つとは限らない」は別の話**である。
 */
function checkBlocks(): { section: string; body: string }[] {
  return blocks().filter((block) => block.body.includes("./task check"));
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

  /** そのブロックが push するか。 */
  function pushes(body: string): boolean {
    return /git push/.test(body);
  }

  /**
   * ブロックを走らせ、**`git push` が呼ばれたか**と**何を記録したか**を返す。
   *
   * **`./task check` を差し替える**（合否とログの中身を作る）。
   * **`git` と `bin/loop-stall` は偽物**にして、**呼ばれたことだけ**を見る。
   */
  function runBlock(body: string, check: string): { pushed: boolean; stalled: string } {
    const workspace = mkdtempSync(join(tmpdir(), "check-push-"));
    try {
      const stub = join(workspace, "stub");
      mkdirSync(stub, { recursive: true });
      mkdirSync(join(workspace, "bin"), { recursive: true });
      writeFileSync(join(stub, "gh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
      writeFileSync(
        join(stub, "git"),
        [
          "#!/usr/bin/env bash",
          `[[ $1 == push ]] && printf 'pushed\\n' >> ${JSON.stringify(join(workspace, "pushed"))}`,
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      writeFileSync(
        join(workspace, "bin", "loop-stall"),
        [
          "#!/usr/bin/env bash",
          `printf '%s\\n' "$*" >> ${JSON.stringify(join(workspace, "stalled"))}`,
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      spawnSync("bash", ["-c", body.replace(/<[^>]+>/g, "1").replaceAll("./task check", check)], {
        cwd: workspace,
        encoding: "utf8",
        env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
      });

      const readIf = (name: string) =>
        existsSync(join(workspace, name)) ? readFileSync(join(workspace, name), "utf8") : "";
      return { pushed: readIf("pushed") !== "", stalled: readIf("stalled") };
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  it("赤のときは、push しない", () => {
    // **`status` を受けただけでは、誰も見ていない**（`tail` は必ず成功する）——
    // **赤でも印が無くても、そのまま push へ進む**。**足りないのは分岐だけ**である
    for (const block of checkBlocks().filter((b) => pushes(b.body))) {
      const result = runBlock(block.body, "bash -c 'echo check-exit=2; exit 2'");

      expect(result.pushed, `${block.section}: 赤なのに push した`).toBe(false);
    }
  });

  it("印が無いときは、push せず記録する", () => {
    // **殺されると印が出ない**（この PR の本体）。**分からないものを緑と読まない**
    for (const block of checkBlocks().filter((b) => pushes(b.body))) {
      const result = runBlock(block.body, "bash -c 'echo 走っている途中; exit 137'");

      expect(result.pushed, `${block.section}: 分からないのに push した`).toBe(false);
      expect(result.stalled, `${block.section}: 押し通した記録が残らない`).toContain(
        "local-ci-unknown",
      );
    }
  });

  it("緑のときは、push する", () => {
    // **止める側だけを見ない**（#168 で踏んだ）。**通る周回で止めては、何も進まない**
    for (const block of checkBlocks().filter((b) => pushes(b.body))) {
      const result = runBlock(block.body, "bash -c 'echo check-exit=0'");

      expect(result.pushed, `${block.section}: 緑なのに push していない`).toBe(true);
      expect(result.stalled, `${block.section}: 緑なのに記録している`).toBe("");
    }
  });

  it("`./task check` を打つ節を、全部並べて突き合わせる", () => {
    // **絞ってから見ない。** **打つのに見ていない節**が 1 つでもあれば、
    // そこから「殺されたのに緑」が入る——**レビューの往復ごとに通る経路**もある
    expect(
      checkBlocks().map((block) => [block.section, block.body.includes("check-exit")]),
    ).toEqual([
      ["### 保留を解いた PR を rebase する", true],
      ["### 保留を解いた PR を rebase する", true],
      ["### 実装は必ずテストファースト", true],
      ["### PR を作る", true],
    ]);
    // **push があるブロックは、分岐してから push する。** **「印を含むか」しか
    // 見ていないと、含んでいるが使っていないが通る**（master の指摘）——
    // **定義の外ではなく、定義の中で何を見るか**である
    expect(checkBlocks().map((block) => [block.section, pushes(block.body)])).toEqual([
      ["### 保留を解いた PR を rebase する", true],
      ["### 保留を解いた PR を rebase する", true],
      ["### 実装は必ずテストファースト", false],
      ["### PR を作る", true],
    ]);
  });

  it("手順書が、印と終了コードの両方を見る", () => {
    // **片方だけだと、片方の壊れ方をそのまま通す**（#147 の本文）。
    // **`status` が空でないこと**と**ログの末尾に印があること**の両方である。
    //
    // **散文ではなく、打つところで見る。** 節全体で見ると**表や説明に
    // `check-exit` があるだけで満たされ**、**ブロックから消しても緑のまま**になる
    // （#168 のレビュー 2 周目で踏んだ形——**書いたのに入っていない**）
    for (const block of checkBlocks()) {
      expect(block.body, `${block.section}: 終了コードを見ていない`).toContain("status=$?");
      expect(block.body, `${block.section}: 終わりの印を見ていない`).toContain("check-exit");
    }
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
