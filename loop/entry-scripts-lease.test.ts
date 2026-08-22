/**
 * **入口で最初に通るスクリプトに、lease 無しの受け口が無い**（#386）。
 *
 * **入口を飛ばした周回は、`bin/loop-lease check` を通るスクリプトに当たるまで
 * 記録されない。** **持っているのは `bin/loop-gate` / `bin/loop-claim` /
 * `bin/loop-head` など**——**どれも「作業に入ってから」通る。**
 *
 * **入口を飛ばす周回は、たいてい「そのまま作業に入る」**（**突かれて始まった周回**）
 * ——**その形は既に 3 度出ている。** **いちばん最初に通るところに受け口が無いと、
 * 記録は「どこまで進んだか」で決まる。**
 *
 * **止めない。** **記録するだけ**である（`bin/loop-lease check` は `|| true` で呼ぶ）。
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** **入口で最初に通る 3 つ**（#386）。 */
const ENTRY_SCRIPTS = ["loop-sync-main", "loop-procedure-changed", "loop-procedure-body"] as const;

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 周回を始められる作業場。**実物のスクリプトを置く**（#227）。 */
function workspace(): { dir: string; stamp: string } {
  const dir = mkdtempSync(join(tmpdir(), "entry-scripts-"));
  sandboxes.push(dir);
  expect(spawnSync("git", ["init", "--quiet", "-b", "main", dir]).status).toBe(0);
  mkdirSync(join(dir, "bin"), { recursive: true });
  for (const name of [...ENTRY_SCRIPTS, "loop-lease", "loop-procedure-stamp", "loop-stall"]) {
    const target = join(dir, "bin", name);
    copyFileSync(join(REPO_ROOT, "bin", name), target);
    chmodSync(target, 0o755);
  }
  mkdirSync(join(dir, ".claude", "commands"), { recursive: true });
  writeFileSync(
    join(dir, ".claude", "commands", "loop-worker.md"),
    "<!-- 版: 000000000000 -->\n手順書\n",
  );
  mkdirSync(join(dir, "loop", "procedure"), { recursive: true });
  writeFileSync(join(dir, "loop", "procedure", "worker.md"), "## 2. やることを決める\n");
  const stamped = spawnSync(join(dir, "bin/loop-procedure-stamp"), ["worker"], {
    cwd: dir,
    encoding: "utf8",
  });
  expect(stamped.status, stamped.stderr).toBe(0);
  return { dir, stamp: stamped.stdout.trim() };
}

/** 入口を飛ばした実行の記録（**作業場をまたいで 1 つ**）。 */
function missingCount(dir: string): number {
  const record = join(dir, ".git", "valence-loop-lease-missing");
  return existsSync(record) ? readFileSync(record, "utf8").split("\n").filter(Boolean).length : 0;
}

function run(dir: string, script: string, args: string[]) {
  return spawnSync(join(dir, "bin", script), args, { cwd: dir, encoding: "utf8" });
}

/** その周回が実際に打つ引数。**引数が違えば、受け口の手前で落ちる。** */
const ARGS: Record<(typeof ENTRY_SCRIPTS)[number], string[]> = {
  "loop-sync-main": ["--fetch-only"],
  "loop-procedure-changed": ["--role", "worker", "HEAD", "HEAD"],
  "loop-procedure-body": ["worker"],
};

describe("入口で最初に通るスクリプトが、lease 無しを記録する", () => {
  for (const script of ENTRY_SCRIPTS) {
    it(`${script} は、lease を持たない実行を記録する`, () => {
      const { dir } = workspace();
      expect(missingCount(dir), "はじめから記録がある").toBe(0);

      run(dir, script, ARGS[script]);

      expect(missingCount(dir), "記録が増えていない").toBe(1);
    });

    it(`${script} は、lease を持っていれば記録しない`, () => {
      // **正常な周回のたびに偽の記録が積まれる形にしない**——**そうなると、
      // 記録そのものが読まれなくなる**
      const { dir, stamp } = workspace();
      const taken = spawnSync(join(dir, "bin/loop-lease"), ["acquire", "worker", stamp], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(taken.status, taken.stderr).toBe(0);

      run(dir, script, ARGS[script]);

      expect(missingCount(dir), "持っているのに記録している").toBe(0);
    });
  }

  it("止めない", () => {
    // **記録するだけ**である——**落とすと、入口を飛ばした周回が、飛ばしたことを
    // 知る前に終わる**
    const { dir } = workspace();

    const done = run(dir, "loop-procedure-body", ["worker"]);

    expect(done.status, "lease が無いだけで落ちている").toBe(0);
  });

  it("本体の出力に、警告を混ぜない", () => {
    // **`bin/loop-procedure-body` の標準出力は、その周回が読む手順そのもの**である
    // ——**警告が混ざると、手順に混ざる。** **記録は標準エラーへ。**
    const { dir } = workspace();

    const done = run(dir, "loop-procedure-body", ["worker"]);

    expect(done.stdout, "手順が出ていない").toContain("やることを決める");
    expect(done.stdout, "手順に警告が混ざっている").not.toMatch(/\[WARN\]|lease/);
    expect(done.stderr, "記録を黙って行っている").toMatch(/lease/);
  });

  it("入口の読み直しは、記録しない", () => {
    // **`--entry` は、印がずれた周回が lease を取る前に読む**（入口 1.0 の回復路。#373）
    // ——**そこで記録すると、正しく回復した周回が毎回「飛ばした」に数えられる。**
    // **記録は診断**なので、**確実な偽物を混ぜない。**
    const { dir } = workspace();

    const done = run(dir, "loop-procedure-body", ["--entry", "worker"]);

    expect(done.status, "回復路で落ちている").toBe(0);
    expect(missingCount(dir), "回復路を「飛ばした」と数えている").toBe(0);
  });
});
