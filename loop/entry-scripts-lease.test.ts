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
   * （**振る舞いの試験 2 本が押さえている**）。
   */
  function runsOnRealRepo(call: string): boolean {
    // **問い合わせは記録より前に返る**（`--list` / `--entry` / `--required-checks`）
    if (/"--list"|"--entry"|"--required-checks"/.test(call)) {
      return false;
    }
    // **`cwd,` の省略記法も「渡している」**である——**見落とすと、砂場で走っている
    // 呼び出しを咎める**（**締めすぎると、この見張りが読まれなくなる**）
    const passesCwd = /cwd:\s*(?!REPO_ROOT)/.test(call) || /(\{|\s)cwd,/.test(call);
    return !passesCwd;
  }

  /**
   * **実物の置き場所を指している名前**（#393）。
   *
   * **直に書いた呼び出ししか見ないと、定数を経由した瞬間に黙る**
   * ——**塞いでいるのが見張りではなくなる。**
   */
  function realPathNames(text: string, script: string): string[] {
    const forms = [
      new RegExp(`const\\s+(\\w+)\\s*=\\s*join\\(REPO_ROOT,\\s*"bin/${script}"\\)`, "g"),
      new RegExp(`const\\s+(\\w+)\\s*=\\s*fileURLToPath\\(new URL\\("\\./${script}"`, "g"),
    ];
    return forms.flatMap((form) => [...text.matchAll(form)].map((match) => match[1] ?? ""));
  }

  /** 起こしている呼び出し（第 1 引数と、その呼び出しの範囲）。 */
  function spawnCalls(text: string): { target: string; call: string }[] {
    return [...text.matchAll(/(spawnSync|execFileSync)\(\s*([^,\n]+),/g)].map((match) => {
      const from = match.index ?? 0;
      const scope = text.slice(from, from + 500);
      return { target: match[2] ?? "", call: scope.split(/\n\s*\}\);/)[0] ?? scope };
    });
  }

  /** その本文が、実物の置き場所から起こしている記録スクリプト。 */
  function offendersIn(label: string, text: string, scripts: string[]): string[] {
    const calls = spawnCalls(text);
    return scripts.flatMap((script) => {
      const names = realPathNames(text, script);
      const direct = `join(REPO_ROOT, "bin/${script}")`;
      return calls
        .filter(({ target }) => target.includes(direct) || names.includes(target.trim()))
        .filter(({ call }) => runsOnRealRepo(call))
        .map(() => `${label}: bin/${script}`);
    });
  }

  it("記録するスクリプトを、実物のリポジトリに対して走らせない", () => {
    // **危ないのは「実物の置き場所から起こす」形**である——**砂場へ写したものを
    // 起こす呼び出し**（`join(dir, "bin", name)`）**は、記録も砂場へ行く。**
    const scripts = recordingScripts();
    expect(scripts.length, "記録する側が 1 つも無い").toBeGreaterThan(0);

    // **この見張り自身は外す。** **下の「見落とす形」の入力が、まさにその形を
    // 文字列で持っている**——**入力を咎めると、見落とす形を試せなくなる。**
    const offenders = testFiles()
      .filter((file) => !file.endsWith("entry-scripts-lease.test.ts"))
      .flatMap((file) => offendersIn(file, readFileSync(join(REPO_ROOT, file), "utf8"), scripts));

    expect(offenders, "実物のリポジトリに対して走らせている").toEqual([]);
  });

  /**
   * **見張り自身が、自分の見落とす形を入力に持つ**（#393 の完了条件）。
   *
   * **いま塞いでいるのが見張りなのか、たまたま置かれた身代わりなのかは、
   * 実物を見ているだけでは分からない**——**見落とす形を置いて、赤くなることを見る。**
   * **#381 の「変異が当たっていない変異試験」の、見張り版**である。
   */
  describe("見張りが、見落とす形を捕まえる", () => {
    const scripts = ["loop-sync-main", "loop-procedure-body"];

    it("定数を経由した呼び出しにも当たる", () => {
      const text = [
        'const SCRIPT = fileURLToPath(new URL("./loop-sync-main", import.meta.url));',
        'const done = spawnSync(SCRIPT, ["--fetch-only"], { encoding: "utf8" });',
      ].join("\n");

      expect(offendersIn("例", text, scripts), "定数を経由すると黙る").toEqual([
        "例: bin/loop-sync-main",
      ]);
    });

    it("join を定数へ入れた呼び出しにも当たる", () => {
      const text = [
        'const BODY = join(REPO_ROOT, "bin/loop-procedure-body");',
        'spawnSync(BODY, ["worker"], { encoding: "utf8" });',
      ].join("\n");

      expect(offendersIn("例", text, scripts)).toEqual(["例: bin/loop-procedure-body"]);
    });

    it("砂場を渡していれば、当たらない", () => {
      // **締めすぎない**——**砂場で起こす呼び出しは、記録もそちらへ行く**
      const text = [
        'const BODY = join(REPO_ROOT, "bin/loop-procedure-body");',
        'spawnSync(BODY, ["worker"], { cwd: sandbox, encoding: "utf8" });',
      ].join("\n");

      expect(offendersIn("例", text, scripts)).toEqual([]);
    });

    it("写したものを起こす呼び出しには、当たらない", () => {
      const text = 'spawnSync(join(dir, "bin", "loop-sync-main"), ["--fetch-only"], {});';

      expect(offendersIn("例", text, scripts)).toEqual([]);
    });

    it("問い合わせには、当たらない", () => {
      const text = [
        'const CHANGED = join(REPO_ROOT, "bin/loop-procedure-changed");',
        'spawnSync(CHANGED, ["--role", "worker", "--list"], { encoding: "utf8" });',
      ].join("\n");

      expect(offendersIn("例", text, ["loop-procedure-changed"])).toEqual([]);
    });
  });
});
