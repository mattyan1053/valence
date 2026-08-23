/**
 * **枝の上で周回を終えると、次の周回が必ず捨てられる**（#405）。
 *
 * **1.1 は `before`（いまの HEAD）と `after`（`origin/main`）を比べる**ので、
 * **枝に居たまま終えると、枝分かれの跡から `main` に入ったぶんが毎回差分に出る**
 * ——**`before` が動かない**ので、**その枝で作業を続ける限り、毎周回捨てられる。**
 *
 * **実測**（2026-08-23、worker-1）: **2 周続けて捨て、手で木を戻して始め直した。**
 *
 * **戻すのは出口である**（**lease を握っている間**）——**返したあとに動かすと、
 * 次の周回の足元から木を抜く**（#68 の形）。
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-return-main", import.meta.url));

type Run = { status: number; stdout: string; stderr: string };

describe("bin/loop-return-main", () => {
  let origin: string;
  let repo: string;

  function git(cwd: string, ...args: string[]): void {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  }

  function commitIn(cwd: string, path: string, contents: string): string {
    writeFileSync(join(cwd, path), contents);
    git(cwd, "add", "-A");
    git(cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", `edit ${path}`);
    return spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).stdout.trim();
  }

  function run(cwd = repo): Run {
    const result = spawnSync(SCRIPT, [], { cwd, encoding: "utf8" });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  /** いまの HEAD。**枝の名前ではなく SHA で見る**（detached で回すので）。 */
  function head(): string {
    return spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
  }

  function originMain(): string {
    return spawnSync("git", ["rev-parse", "origin/main"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim();
  }

  beforeEach(() => {
    origin = mkdtempSync(join(tmpdir(), "return-main-origin-"));
    git(origin, "init", "--quiet", "-b", "main", ".");
    commitIn(origin, "README.md", "初期\n");
    repo = mkdtempSync(join(tmpdir(), "return-main-"));
    rmSync(repo, { recursive: true, force: true });
    expect(spawnSync("git", ["clone", "--quiet", origin, repo]).status, "clone できない").toBe(0);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  });

  it("枝の上にいたら、origin/main の先端へ戻す", () => {
    // **これが本題。** **戻さないと、次の周回は必ず捨てられる**
    git(repo, "switch", "--quiet", "-c", "feat/x");
    const onBranch = commitIn(repo, "README.md", "枝の変更\n");
    expect(head(), "枝の上にいない").toBe(onBranch);

    expect(run().status, run().stderr).toBe(0);

    expect(head(), "origin/main へ戻っていない").toBe(originMain());
  });

  it("もともと origin/main の先端なら、何もしない", () => {
    // **master は枝へ移らない**（**当たるのは worker だけ**）——**手順は 1 つ**なので、
    // **移っていない周回でも通る**必要がある
    expect(head()).toBe(originMain());

    expect(run().status, "そこに居るのに落ちている").toBe(0);
  });

  it("dirty なら、戻さずに言う", () => {
    // **持ったまま移ると、どの枝の作業か消える**（1.0 と同じ判断）——
    // **黙って進まない**（#405 の完了条件）
    git(repo, "switch", "--quiet", "-c", "feat/x");
    const onBranch = commitIn(repo, "README.md", "枝の変更\n");
    writeFileSync(join(repo, "README.md"), "まだ commit していない\n");

    const answered = run();

    expect(answered.status, "dirty のまま動いている").toBe(1);
    expect(head(), "dirty なのに木を動かしている").toBe(onBranch);
    expect(answered.stderr, "理由を言っていない").toMatch(/dirty|変更/);
  });

  it("追跡していない場所では、判定できないと言う", () => {
    // **「戻せなかった」と「そもそも分からない」を混ぜない**
    const bare = mkdtempSync(join(tmpdir(), "return-main-bare-"));
    git(bare, "init", "--quiet", "-b", "main", ".");
    commitIn(bare, "README.md", "初期\n");

    const answered = run(bare);

    expect(answered.status, "origin/main が無いのに戻ったと言っている").toBe(2);
    rmSync(bare, { recursive: true, force: true });
  });

  it("git の外では、判定できないと言う", () => {
    const outside = mkdtempSync(join(tmpdir(), "return-main-outside-"));

    expect(run(outside).status).toBe(2);

    rmSync(outside, { recursive: true, force: true });
  });
});
