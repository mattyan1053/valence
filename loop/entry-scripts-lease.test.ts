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
  readdirSync,
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

  it("一覧は、記録しない", () => {
    // **一覧は問い合わせである**——**尋ねるたびに偽の「入口を飛ばした」が積まれると、
    // 保つ 20 件が入れ替わり、本物が残らない**（#390 のレビュー）
    const { dir } = workspace();

    const done = run(dir, "loop-procedure-changed", ["--role", "worker", "--list"]);

    expect(done.status, "一覧を出せていない").toBe(0);
    expect(missingCount(dir), "問い合わせを「飛ばした」と数えている").toBe(0);
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

/**
 * **ふつうの `./task check` が、共有の記録を動かさない**（#390 のレビュー）。
 *
 * **記録は作業場をまたいで 1 つ**で、**保つのは 20 件**である——**試験が実物の
 * リポジトリに対して実物のスクリプトを走らせると、その場で記録が積まれ**、
 * **数回の `./task check` で本物の「入口を飛ばした周回」が押し出される。**
 *
 * **見えるようにするために足した受け口の記録が、試験の音で埋まる**
 * ——**`AGENTS.md` §5 が名指ししている形**である（#186。**観測をやめて、
 * 自分の砂場に身代わりを置く**）。
 */
describe("試験が、共有の記録を汚さない", () => {
  /** **記録する側のスクリプト**（一覧は実物から作る。**書き写さない**）。 */
  function recordingScripts(): string[] {
    return readdirSync(join(REPO_ROOT, "bin"))
      .filter((name) => !name.endsWith(".test.ts"))
      .filter((name) =>
        readFileSync(join(REPO_ROOT, "bin", name), "utf8").includes('/loop-lease" check'),
      );
  }

  /** 試験のファイル。**足された試験も自動で入る**（並べると、足した人が漏れる）。 */
  function testFiles(): string[] {
    return ["bin", "loop"].flatMap((dir) =>
      readdirSync(join(REPO_ROOT, dir))
        .filter((name) => name.endsWith(".test.ts"))
        .map((name) => `${dir}/${name}`),
    );
  }

  /**
   * その呼び出しが、**実物のリポジトリで走るか**。
   *
   * **`cwd` を渡していない呼び出しは、vitest の cwd（＝実物）で走る。**
   * **問い合わせ（`--list` / `--entry`）は記録より前に返る**ので、ここでは見ない
   * （**下の 2 本が振る舞いで押さえている**）。
   */
  function runsOnRealRepo(call: string): boolean {
    if (/"--list"|"--entry"/.test(call)) {
      return false;
    }
    return !/cwd:/.test(call) || /cwd:\s*REPO_ROOT/.test(call);
  }

  /** その試験ファイルが、実物の置き場所から起こしている記録スクリプト。 */
  function offendersIn(file: string, scripts: string[]): string[] {
    const text = readFileSync(join(REPO_ROOT, file), "utf8");
    return scripts.flatMap((script) => {
      const spawn = new RegExp(
        `(spawnSync|execFileSync)\\(\\s*join\\(REPO_ROOT,\\s*"bin/${script}"\\)`,
        "g",
      );
      return [...text.matchAll(spawn)]
        .map((match) => text.slice(match.index ?? 0, (match.index ?? 0) + 500))
        .map((scope) => scope.split(/\n\s*\}\);/)[0] ?? scope)
        .filter(runsOnRealRepo)
        .map(() => `${file}: bin/${script}`);
    });
  }

  it("記録するスクリプトを、実物のリポジトリに対して走らせない", () => {
    // **危ないのは「実物の置き場所から起こす」形**である——**砂場へ写したものを
    // 起こす呼び出し**（`join(dir, "bin", name)`）**は、記録も砂場へ行く。**
    const scripts = recordingScripts();
    expect(scripts.length, "記録する側が 1 つも無い").toBeGreaterThan(0);

    const offenders = testFiles().flatMap((file) => offendersIn(file, scripts));

    expect(offenders, "実物のリポジトリに対して走らせている").toEqual([]);
  });
});
