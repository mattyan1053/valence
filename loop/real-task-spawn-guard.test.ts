/**
 * **試験が、実物のループを止めた**（#587）。
 *
 * **`loop/STOP` が実際に置かれた**（2026-09-03）。**人間側の見張りが検出**し、
 * **「誰も心当たりが無い STOP」として調べが始まった**——**4 つ全部に配られていれば、
 * 全ループが止まっていた。** **1 つで済んだのは偶然**である（**`cmd_loop_stop` が
 * 権限で打ち切られた**）。
 *
 * ```ts
 * // 書いてしまったもの
 * const again = spawnSync(join(REPO_ROOT, "task"), ["loop:stop", "あとから"], {
 *   cwd: repo,          // 砂場を指したつもりだった
 * });
 * ```
 *
 * **`cwd` は効かない。** **実物の `task` は自分の居場所を基準に `git worktree list`
 * を見る**ので、**呼ぶ実体が実物なら、実物を触る。**
 *
 * **散文では止められなかった。** **`AGENTS.md` §5 に「完了条件に『実物へ置いて
 * 確かめる』と書かない」と書いてあり**、**踏んだ本人は同じ PR の中で #186 を
 * 引用していた。** **知っていて、書いてあって、それでも踏んだ**——**「散文には
 * 書いてあるのに、実行されるブロックには無い」**（#176 のレビュー）。
 *
 * ## 何を止めるか
 *
 * **「状態を変える下位コマンドだけ」は選ばなかった。** **どれが状態を変えるかは
 * 手で並べるしかなく**、**あとから変わる**（**いま読むだけの口が、明日書くように
 * なっても、一覧は黙っている**）。**spawn そのものを止めれば、一覧が要らない。**
 *
 * **複製してから呼ぶ形は通す**——**それが既存の試験の形**である。
 *
 * ## 別名は 1 段だけ追う
 *
 * **`loop/record-growth-guard.test.ts` が書いているとおり**、**別名を追う見張りは
 * 追う形を 1 つずつ足す限り終わらない。** **ここでは `const X = join(REPO_ROOT, "task")`
 * の 1 段だけ**を追う（**実在するのがその形**）。**それより深いものは追わない**
 * ——**追えないことを、追えるふりで隠さない。**
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** **実物の `task` を指す式**（**書かれている形**）。 */
const REAL_TASK = String.raw`join\(\s*REPO_ROOT\s*,\s*"task"\s*\)`;

/** **子プロセスを起こす口**（`node:child_process`）。 */
const SPAWNS = "(?:spawnSync|spawn|execFileSync|execSync|exec|fork)";

/**
 * **実物の `task` を spawn している行**を返す。
 *
 * **1 段だけ別名を追う**——**`const X = join(REPO_ROOT, "task")` で受けてから
 * 渡す形が実在する**ため。
 */
function spawnsRealTask(source: string): string[] {
  const aliases = [
    ...source.matchAll(new RegExp(String.raw`const\s+(\w+)\s*=\s*${REAL_TASK}`, "g")),
  ]
    .map((hit) => hit[1])
    .filter((name): name is string => name !== undefined);
  const commands = [REAL_TASK, ...aliases.map((name) => String.raw`${name}\b`)].join("|");
  // **ソース全体へ当てる** (#590 のレビュー)。**行に割ると `\s*` が改行を食えなくなる**
  // ——**Biome は長い呼び出しを `(` の直後で折る**ので、**整形 1 回で素通りする。**
  const calls = new RegExp(String.raw`${SPAWNS}\(\s*(?:${commands})`, "g");
  const lines = source.split("\n");
  // **報告する行は、当たった位置から引き直す**——**呼び出しが始まる行**が、読む人の要る場所。
  return [...source.matchAll(calls)].map((hit) => {
    const at = source.slice(0, hit.index).split("\n").length;
    return `${at}: ${lines[at - 1]?.trim() ?? ""}`;
  });
}

/**
 * **この判定を持つファイル**。**踏んだ形そのものを見本として置いてある**ので、
 * **自分を数えると必ず赤くなる。** **外すのはここ 1 つだけ**——**増えたら、
 * それは見張りが緩んだ印**である（下の「見ている先が減っていない」が数える）。
 */
const SELF = "real-task-spawn-guard.test.ts";

/** すべての試験ファイル。**外す名前は渡す**——**数えられるようにするため。** */
function testFiles(skip: ReadonlySet<string> = new Set([SELF]), dir: string = REPO_ROOT): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === ".next") {
      continue;
    }
    if (skip.has(name)) {
      continue;
    }
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      found.push(...testFiles(skip, path));
    } else if (name.endsWith(".test.ts")) {
      found.push(path);
    }
  }
  return found;
}

describe("試験は、実物の task を呼ばない（#587）", () => {
  it("実物の task を spawn している試験は無い", () => {
    const guilty = testFiles().flatMap((path) =>
      spawnsRealTask(readFileSync(path, "utf8")).map(
        (line) => `${relative(REPO_ROOT, path)}: ${line.trim()}`,
      ),
    );

    expect(guilty, "実物の task を呼んでいる（砂場へ複製してから呼ぶこと）").toEqual([]);
  });

  it("見ている先が減っていない（外すのは判定を持つファイルだけ）", () => {
    // **除外は黙って増やせる**——**増やしても、走らせているぶんは緑のまま**である。
    // **外した名前を数える**：**全部から外したぶんを引くと、判定を持つファイル 1 つ**。
    const scanned = new Set(testFiles());
    const skipped = testFiles(new Set())
      .filter((path) => !scanned.has(path))
      .map((path) => relative(REPO_ROOT, path));

    expect(skipped, "外しているファイルが増えている").toEqual([join("loop", SELF)]);
  });

  it("execFileSync で呼ぶ形も、捕まる", () => {
    // **実在した違反の片方が execFileSync**である（#587 で直した 2 件のうち 1 件）
    // ——**`spawnSync` だけを見ていると、そちらが素通りする。**
    const source = 'const help = execFileSync(join(REPO_ROOT, "task"), ["help"], {});';

    expect(spawnsRealTask(source), "execFileSync を見ていない").toHaveLength(1);
  });

  it("状態を変える下位コマンドで呼ぶ形は、捕まる", () => {
    // **実際に踏んだ形そのもの**（#587）——**`cwd` を砂場にしても効かない。**
    const source = [
      'const again = spawnSync(join(REPO_ROOT, "task"), ["loop:stop", "あとから"], {',
      "  cwd: repo,",
      "});",
    ].join("\n");

    expect(spawnsRealTask(source), "踏んだ形を捕まえていない").toHaveLength(1);
  });

  it("改行をまたぐ呼び出しも、捕まる", () => {
    // **Biome が長い呼び出しをこの形へ整形する**（#590 のレビュー）——**書いた人が
    // 改行を選ばなくても、整形が選ぶ。** **しかも整形は緑のまま通る**ので、
    // **この判定が止めたい事故が、整形 1 回で戻る。**
    const source = [
      "spawnSync(",
      '  join(REPO_ROOT, "task"),',
      '  ["loop:stop"],',
      "  { cwd: repo },",
      ");",
    ].join("\n");

    expect(spawnsRealTask(source), "改行をまたぐと素通りする").toHaveLength(1);
  });

  it("別名で受けてから渡す形も、捕まる", () => {
    const source = [
      'const TASK = join(REPO_ROOT, "task");',
      'spawnSync(TASK, ["loop:stop"]);',
    ].join("\n");

    expect(spawnsRealTask(source), "別名を追えていない").toHaveLength(1);
  });

  it("砂場へ複製してから呼ぶ形は、通す", () => {
    // **既存の試験の形**である——**ここを赤くすると、直しようが無くなる。**
    const source = [
      'copyFileSync(join(REPO_ROOT, "task"), join(repo, "task"));',
      'spawnSync("./task", ["loop:stop"], { cwd: repo });',
    ].join("\n");

    expect(spawnsRealTask(source), "砂場へ複製した形まで止めている").toEqual([]);
  });

  it("読むだけの形は、通す", () => {
    // **中身を読む試験は多い**（`./task` の関数をそのまま取り出す形）
    const source = 'const runner = readFileSync(join(REPO_ROOT, "task"), "utf8");';

    expect(spawnsRealTask(source), "読むだけを止めている").toEqual([]);
  });
});
