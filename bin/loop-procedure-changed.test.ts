import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-procedure-changed", import.meta.url));

type Run = { status: number; stdout: string; stderr: string };

describe("bin/loop-procedure-changed", () => {
  let repo: string;

  function git(...args: string[]): void {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  }

  /** 使い捨ての git リポジトリに commit を作る。**実リポジトリの履歴は触らない。** */
  function commit(path: string, contents: string): string {
    mkdirSync(join(repo, dirname(path)), { recursive: true });
    writeFileSync(join(repo, path), contents);
    git("add", "-A");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", `edit ${path}`);
    return spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
  }

  function run(...args: string[]): Run {
    const result = spawnSync(SCRIPT, args, { cwd: repo, encoding: "utf8" });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "loop-procedure-"));
    git("init", "--quiet", ".");
    commit("README.md", "初期\n");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it.each([".claude/commands/loop-master.md", "bin/loop-gate", "task", "loop/README.md"])(
    "%s が変わったら、変わったと判定する",
    (path) => {
      // **master が周回中に読む・実行するもの。** 入れ替わったまま走ると、
      // いま読んでいる手順書と、これから実行する手順書が食い違う
      const before = commit("src/other.ts", "前\n");
      commit(path, "後\n");

      expect(run(before).status).toBe(0);
    },
  );

  it("対象外のファイルだけなら、変わっていないと判定する", () => {
    // **これが本題。** マージのたびに周回を捨てていたのは、`src/` しか触らない
    // PR でも「HEAD が動いた」で打ち切っていたため
    const before = commit("bin/loop-gate", "前\n");
    commit("src/domain/graph/dependency-graph.ts", "後\n");

    expect(run(before).status).toBe(1);
  });

  it("worker の手順書だけなら、変わっていないと判定する", () => {
    // master が実行するのは master の手順書である。**worker 側の変更で捨てない**
    const before = commit("bin/loop-gate", "前\n");
    commit(".claude/commands/loop-worker.md", "後\n");

    expect(run(before).status).toBe(1);
  });

  it("HEAD と同じなら、変わっていないと判定する", () => {
    const before = commit("bin/loop-gate", "前\n");

    expect(run(before).status).toBe(1);
  });

  it("対象と対象外が混ざっていたら、変わったと判定する", () => {
    // **捨てる側に倒す。** 1 つでも入れ替わっていれば、走らせてはいけない
    const before = commit("src/a.ts", "前\n");
    mkdirSync(join(repo, "bin"), { recursive: true });
    writeFileSync(join(repo, "bin/loop-gate"), "後\n");
    writeFileSync(join(repo, "src/a.ts"), "後\n");
    git("add", "-A");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "mixed");

    expect(run(before).status).toBe(0);
  });

  it("判定できなければ 2 で落ちる", () => {
    // **判定不能を「変わっていない」に倒さない。** 古い手順で走り続けるより止まる
    expect(run("0000000000000000000000000000000000000000").status).toBe(2);
    expect(run().status).toBe(2);
    expect(run("HEAD", "余計な引数").status).toBe(2);
  });

  it("対象の一覧を出せる", () => {
    // **一覧の正はスクリプト 1 箇所。** 手順書に書き写すと、片方だけ直して食い違う
    const listed = run("--list");

    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain("bin/");
  });
});
