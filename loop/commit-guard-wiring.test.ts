import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOOK = ".githooks/pre-commit";

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/**
 * 検査が、実際に commit を止める（#68）。
 *
 * **判定を書いただけでは 1 度も走らない。** git の hook は**リポジトリに置いても
 * 有効にならない**（`core.hooksPath` を向けるまで `.git/hooks` を見る）。
 * **手順書に書くのでも足りない**——**モデルの自制に依存しない**（`loop/README.md`）。
 *
 * **「入れたが、誰も見ていない」は #171 の周回で 3 度出た形**である。
 * ここでは**実際に commit してみて、止まること**まで見る（Issue の完了条件）。
 */
describe("main の上での commit", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "commit-guard-wiring-"));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function git(...args: string[]): string {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  }

  /**
   * **実物を写した作業ツリー**を作る。
   *
   * **本物のリポジトリでは試せない。** `git commit` を実際に打つので、
   * **試験がこのリポジトリの履歴を触ることになる**。
   */
  function realWorkspace(): void {
    git("init", "--quiet", "-b", "main", ".");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    for (const [from, mode] of [
      [HOOK, 0o755],
      ["bin/loop-commit-guard", 0o755],
      ["task", 0o755],
    ] as const) {
      mkdirSync(join(repo, from.slice(0, from.lastIndexOf("/")) || "."), { recursive: true });
      copyFileSync(join(REPO_ROOT, from), join(repo, from));
      chmodSync(join(repo, from), mode);
    }
    // **main に commit が 1 つ要る。** 生まれていない main からはブランチへ移れず、
    // **「戻された」経路をそもそも作れない**。**hook が有効になる前に置く**
    git("add", "-A");
    git("commit", "--quiet", "--no-verify", "-m", "seed");
  }

  /** その作業ツリーで commit してみる。 */
  function commit(): { status: number; stderr: string } {
    execFileSync("git", ["-C", repo, "add", "-A"]);
    const result = spawnSync("git", ["-C", repo, "commit", "-m", "試し"], { encoding: "utf8" });
    return { status: result.status ?? -1, stderr: result.stderr };
  }

  it("`./task` を 1 回打つと、hook が有効になる", () => {
    // **置いただけでは走らない。** `core.hooksPath` を向けるのは**人の手順にしない**——
    // **手順は忘れられるし、忘れたことは commit が通ってから分かる**。
    // **`./task` は必ず通る**（`./task check` を打たない周回が無い）ので、そこで揃える
    realWorkspace();

    const ran = spawnSync(join(repo, "task"), ["help"], { encoding: "utf8" });

    expect(ran.status, "`./task` が落ちている").toBe(0);
    expect(git("config", "--get", "core.hooksPath").trim()).toBe(".githooks");
  });

  it("別の値が入っていても、揃え直す", () => {
    // **「まだ設定されていないときだけ入れる」にしない。** git の hook 置き場は
    // **1 つしか指せない**ので、**他のものが向けた先が残っていると、この検査は
    // 走らないまま**になる——**入れた側からは、入れたように見える**
    realWorkspace();
    git("config", "core.hooksPath", ".other-hooks");

    spawnSync(join(repo, "task"), ["help"], { encoding: "utf8" });

    expect(git("config", "--get", "core.hooksPath").trim()).toBe(".githooks");
  });

  it("main の上では、実際に commit が止まる", () => {
    // **完了条件の 1 つ目。** **手順書に書いただけにしない**
    realWorkspace();
    spawnSync(join(repo, "task"), ["help"], { encoding: "utf8" });
    const before = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "新しいファイル"), "x\n");

    const result = commit();

    expect(result.status, "main の上なのに commit できた").not.toBe(0);
    expect(result.stderr, "止めた理由が出ていない").toContain("main");
    // **commit が本当に作られていない**（hook が「止めた顔」だけをしていない）
    expect(git("rev-parse", "HEAD"), "main の上に commit が載った").toBe(before);
  });

  it("ブランチを切ったあとに main へ戻されても、止まる", () => {
    // **完了条件の 2 つ目。** **2 回ともこの経路である**
    realWorkspace();
    spawnSync(join(repo, "task"), ["help"], { encoding: "utf8" });
    git("switch", "--quiet", "-c", "feat/something");
    git("switch", "--quiet", "main");
    writeFileSync(join(repo, "新しいファイル"), "x\n");

    expect(commit().status, "戻された経路を素通りしている").not.toBe(0);
  });

  it("ブランチの上では、commit できる", () => {
    // **止める側だけを見ない**（#168 で踏んだ）。**通る道で止めては、何も進まない**
    realWorkspace();
    spawnSync(join(repo, "task"), ["help"], { encoding: "utf8" });
    git("switch", "--quiet", "-c", "feat/work");
    writeFileSync(join(repo, "新しいファイル"), "x\n");

    expect(commit().status, "ブランチの上なのに止まっている").toBe(0);
  });

  it("hook に実行ビットが立っている", () => {
    // **これが黙って外れる形である。** git は**実行できない hook を hint 1 行で飛ばし、
    // そのまま commit する**——**止めているつもりで、何も止まっていない**。
    // **ファイルシステムではなく git の index を見る**（clone した先に載るのはこちら）
    const entry = execFileSync("git", ["ls-files", "-s", HOOK], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    expect(entry.startsWith("100755 "), `${HOOK} が実行可能で入っていない: ${entry}`).toBe(true);
  });

  it("判定は 1 箇所に置く", () => {
    // **同じ判定を 2 箇所に持つと、片方だけ直して食い違う**（#159 で踏んだ）。
    // hook は**呼ぶだけ**にする
    expect(read(HOOK), "hook が判定を呼んでいない").toContain("loop-commit-guard");
    expect(read(HOOK), "hook が自前で判定している").not.toContain("symbolic-ref");
  });
});
