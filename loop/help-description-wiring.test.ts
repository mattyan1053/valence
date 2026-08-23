/**
 * **口を足したときに、`./task help` から説明が消えることがある**（#426）。
 *
 * **`cmd_help` は「定義の直前のコメント」を説明として拾う。** **外れる形が 2 つある**
 * （**#423 で両方踏んだ**）。
 *
 * - **間に関数を挟む**——**説明と定義が離れ、一覧から行が丸ごと消える**
 * - **理由を最後に置く**——**理由の行が説明として並ぶ**
 *
 * **口そのものは動く**（**#423 では `bin/loop-cadence` が読めていた**）ので、
 * **出力を見なければ気づかない**——**#155 の家族**である。
 *
 * **1 つずつ試験を足すのをやめる。** **#155 で `loop:status`、#423 でもう 2 つ**
 * ——**足し忘れた口は、誰も見ない。**
 *
 * **一覧を書き写さない**——**口は `task` の定義から読み、説明は実物の `cmd_help` に
 * 出させる**（**awk の本体を取り出して、そのまま走らせる**）。
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TASK = readFileSync(join(REPO_ROOT, "task"), "utf8");

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** `cmd_help` が使っている awk の本体。**書き写さない**（実物を取り出す）。 */
function helpProgram(): string {
  // **`cmd_help` の中から取る**——**`task` には awk が何度も出てくる。**
  const body = TASK.indexOf("cmd_help() {");
  expect(body, "cmd_help が見つからない").toBeGreaterThan(0);
  const from = TASK.indexOf("awk '", body);
  const to = TASK.indexOf('\' "$0"', from);
  expect(from, "cmd_help の awk が見つからない").toBeGreaterThan(0);
  expect(to, "cmd_help の awk の終わりが見つからない").toBeGreaterThan(from);
  return TASK.slice(from + "awk '".length, to);
}

/** その本文を `cmd_help` に読ませて、並んだ「口 → 説明」を返す。 */
function helpOf(text: string): Map<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "help-desc-"));
  sandboxes.push(dir);
  const file = join(dir, "task");
  writeFileSync(file, text);
  const shown = spawnSync("awk", [helpProgram(), file], { encoding: "utf8" });
  expect(shown.status, shown.stderr).toBe(0);
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  const listed = new Map<string, string>();
  for (const line of shown.stdout.replaceAll(ansi, "").split("\n")) {
    const found = /^\s+(\S+)\s+(\S.*)$/.exec(line);
    if (found !== null) {
      listed.set(found[1] ?? "", found[2] ?? "");
    }
  }
  return listed;
}

/**
 * その本文が持っている口。**定義から読む。**
 *
 * **名前の作り方は `cmd_help` と同じ**（`cmd_` を落として `_` を `:` にする）。
 */
function commandsOf(text: string): string[] {
  return [...text.matchAll(/^cmd_([a-z0-9_]+)\(\)/gm)].map((found) =>
    (found[1] ?? "").replaceAll("_", ":"),
  );
}

/**
 * 説明の行に、理由が書かれている口。
 *
 * **`cmd_help` が拾うのは、直前の連続したコメントの最後の 1 行**である
 * ——**理由を最後に置くと、理由が説明として並ぶ**（#423 で 3 件踏んだ）。
 *
 * **「直前の何行がコメントか」では決まらない** (#428 のレビュー)——**区切りの `#` を
 * 挟んだ 1 行の理由**（説明・空のコメント行・理由 1 行）**も、この書き方をよくする**ので、
 * **段落の長さごとに条件が要る**ことになる。
 *
 * **見るのは、拾われた行そのもの**である。**理由は太字で書く**（このリポジトリの書き方）
 * ——**説明は 1 行の一覧に並ぶ文**なので、**太字の印を持たない。**
 */
function reasonAsDescription(text: string): string[] {
  const listed = helpOf(text);
  return [...listed].filter(([, desc]) => desc.includes("**")).map(([name]) => name);
}

describe("足した口の説明が、`./task help` に並ぶ", () => {
  it("全部の口が、説明つきで並んでいる", () => {
    // **これが本体である。** **1 つずつ試験を足すのをやめる**（#155 / #423）
    const listed = helpOf(TASK);

    expect(
      commandsOf(TASK).filter((name) => !listed.has(name)),
      "説明が定義の直前に無い（間に関数を挟んでいないか）",
    ).toEqual([]);
  });

  it("説明の行に、理由が書かれている口が無い", () => {
    // **理由を最後に置くと、理由が説明として並ぶ**（#423 で 3 件踏んだ）
    expect(reasonAsDescription(TASK), "説明を段落の最後に置くこと（理由は、その前に書く）").toEqual(
      [],
    );
  });

  it("空振りしていない（実物の口と説明を、実際に読めている）", () => {
    // **0 件を「全部並んでいる」と読まない**——**読めていなければ、何を足しても緑**
    const listed = helpOf(TASK);

    expect(commandsOf(TASK), "口を読めていない").toContain("doctor");
    expect(listed.get("doctor"), "説明を読めていない").toMatch(/\S/);
    expect(listed.size, "説明を 1 つも読めていない").toBeGreaterThan(10);
  });
});

describe("見落とす形を、入力に置く", () => {
  it("間に関数を挟むと、一覧から消える", () => {
    // **#423 で踏んだ形**（`master_worktree_path` を、説明と定義の間に置いた）
    const text = "# 何かをする\nhelper() { :; }\n\ncmd_thing() { :; }\n";

    expect(commandsOf(text), "口として読めていない").toContain("thing");
    expect(helpOf(text).has("thing"), "消えるはずが、並んでいる").toBe(false);
  });

  it("理由を最後に置くと、理由が説明として並ぶ", () => {
    // **並びはする**ので、**上の「並んでいるか」では捕まらない**——**別の判定が要る**
    const text = "# 何かをする\n# **なぜなら、こうだから**\ncmd_thing() { :; }\n";

    expect(helpOf(text).get("thing"), "理由が説明として並んでいない").toMatch(/なぜなら/);
    expect(reasonAsDescription(text), "理由が説明になっていると言っていない").toContain("thing");
  });

  it("1 行だけの理由でも、拾う", () => {
    // **区切りの `#` を挟んだ、いちばん短い形**（#428 のレビュー）
    // ——**このリポジトリは、この書き方をよくする**（説明・空のコメント行・理由 1 行）。
    const text = "# 何かをする\n#\n# **なぜなら、こうだから**\ncmd_thing() { :; }\n";

    expect(helpOf(text).get("thing"), "理由が説明として並んでいない").toMatch(/なぜなら/);
    expect(reasonAsDescription(text), "1 行だけの理由を見逃している").toContain("thing");
  });

  it("説明を最後に置いてあれば、理由とは言わない", () => {
    // **理由を書いてはいけない、ではない**——**説明を段落の最後に置けばよい**
    const text = "# **なぜなら、こうだから**\n#\n# 何かをする\ncmd_thing() { :; }\n";

    expect(helpOf(text).get("thing"), "説明が並んでいない").toBe("何かをする");
    expect(reasonAsDescription(text), "説明なのに、理由だと言っている").toEqual([]);
  });
});
