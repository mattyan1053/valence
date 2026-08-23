/**
 * **機械が読む口を `./task` に足すたびに、問い合わせの並びへ入れ忘れる**（#424）。
 *
 * **3 度起きた。** **#381（`loop:worker:paths`）／#416（`port`）／#423
 * （`loop:master:path`）**——**どれも「足した口が、前置きより先に返らない」**である。
 *
 * **`./task` は打つたびに前置きを通す**（`warn_stale_containers` など）。
 * **あれは標準出力へ出す**ので、**`$( )` で読むと警告の文が答えに混ざる。**
 *
 * **忘れても、その場では何も起きない。** **壊れるのは呼んでいる側**で、
 * **しかも「警告が出ている作業場」でしか出ない**——**手元では気づかない。**
 *
 * **一覧を書き写さない。** **呼んでいる側（`bin/`）と、並び（`task`）の両方を、
 * 実物から読む**——**写すと、片方だけ古くなる**（**この見張り自身が、
 * 見張りたい形になる**）。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TASK = readFileSync(join(REPO_ROOT, "task"), "utf8");

/** `./task` が持っている口。**定義から読む**（`cmd_<名前>`）。 */
function commandsOf(task: string): Set<string> {
  return new Set([...task.matchAll(/^cmd_([a-z0-9_]+)\(\)/gm)].map((found) => found[1] ?? ""));
}

/**
 * その名前が `./task` の口か。
 *
 * **変換は `main()` が持っている**（`cmd_${raw//:/_}` のあと `-` を `_` へ）
 * ——**逆向きには戻せない**ので、**同じ向きに変換して突き合わせる。**
 */
function isCommand(name: string, commands: Set<string>): boolean {
  return commands.has(name.replaceAll(":", "_").replaceAll("-", "_"));
}

/**
 * 前置きより先に返す口の並び。**`main()` の `case` から読む。**
 *
 * **書き写さない**——**並びが増えても減っても、ここは実物を読む。**
 */
function fastPathOf(task: string): Set<string> {
  const main = task.slice(task.indexOf('case "$raw" in'));
  const line = main.slice(0, main.indexOf(")")).split("\n").pop() ?? "";
  return new Set(
    line
      .split("|")
      .map((one) => one.trim())
      .filter(Boolean),
  );
}

/**
 * その本文が `$( )` の中で呼んでいる `./task` の口。
 *
 * **`./task` の書かれ方は 1 つではない**——**`./task` / `"$TASK"` /
 * `"$(git rev-parse --show-toplevel)/task"` が実際に使われている。**
 * **`task` で終わる語を探し、その次の語を口として読む**——**別名を 1 つずつ
 * 並べない**（#394。**並べる限り終わらない**）。
 */
function queriesIn(text: string, commands: Set<string>): string[] {
  // **コメントは外す**——**説明の中の `./task db:up` は、呼んでいない。**
  const code = text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const found: string[] = [];
  for (const substitution of code.matchAll(/\$\((?:[^()]|\([^()]*\))*\)/g)) {
    // **入れ子の `$( )` だけを潰す**（**外側の `$( )` は剥がしてから**）
    // ——**`"$(git …)/task"` の中身は口ではない。**
    // **外側ごと潰すと、`$(./task port)` が丸ごと消える**（**空振りする**）。
    const inner = (substitution[0] ?? "").slice(2, -1).replaceAll(/\$\([^()]*\)/g, "X");
    for (const call of inner.matchAll(/(?:^|["\s(])[^\s"]*task[^\s"]*"?\s+([A-Za-z][\w:-]*)/gi)) {
      const name = call[1] ?? "";
      if (isCommand(name, commands)) {
        found.push(name);
      }
    }
  }
  return found;
}

/** `bin/` にあるスクリプト（試験は除く）。 */
function binScripts(): { name: string; text: string }[] {
  return readdirSync(join(REPO_ROOT, "bin"))
    .filter((name) => !name.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(join(REPO_ROOT, "bin", name), "utf8") }));
}

describe("bin が `$( )` で読む口は、前置きより先に返る", () => {
  it("いま呼んでいる口が、すべて並びに入っている", () => {
    // **これが本体である。** **足した口を並びへ入れ忘れたら、ここで赤くなる。**
    const commands = commandsOf(TASK);
    const fast = fastPathOf(TASK);
    const missing: string[] = [];
    for (const script of binScripts()) {
      for (const name of queriesIn(script.text, commands)) {
        if (!fast.has(name)) {
          missing.push(`${script.name} が $( ) で読んでいる: ${name}`);
        }
      }
    }

    expect(missing, "問い合わせの並び（task の case）へ入れること").toEqual([]);
  });

  it("空振りしていない（実物の口を、実際に拾っている）", () => {
    // **0 件を「全部入っている」と読まない**——**拾えていなければ、何を足しても緑**である
    const commands = commandsOf(TASK);
    const seen = binScripts().flatMap((script) => queriesIn(script.text, commands));

    expect(seen, "実物の呼び出しを 1 つも拾えていない").toContain("port");
    expect(seen, "変数ごしの呼び出しを拾えていない").toContain("loop:stop:paths");
    expect(seen, "入れ子の $( ) ごしの呼び出しを拾えていない").toContain("loop:worker:paths");
  });
});

describe("見落とす形を、入力に置く", () => {
  const commands = commandsOf(TASK);

  it("並びに無い口を読んでいたら、拾う", () => {
    // **#424 が起票された形そのもの**（**足したが、並びへ入れ忘れた**）
    expect(queriesIn('port="$(./task doctor)"\n', commands)).toContain("doctor");
  });

  it("変数ごしでも拾う", () => {
    // **`bin/loop-stall` の形**（`readonly TASK="$toplevel/task"`）
    expect(queriesIn('paths="$("$TASK" loop:stop:paths)"\n', commands)).toContain(
      "loop:stop:paths",
    );
  });

  it("入れ子の `$( )` ごしでも拾う", () => {
    // **`bin/loop-cadence` の形**
    expect(
      queriesIn('list="$("$(git rev-parse --show-toplevel)/task" loop:worker:paths)"\n', commands),
    ).toContain("loop:worker:paths");
  });

  it("`$( )` で読んでいないものは、数えない", () => {
    // **何かを起こす口は、これまでどおり前置きを通す** (#416)
    // ——**この見張りは、前置きを外す口を増やす話ではない。**
    expect(queriesIn("./task up\n./task db:up\n", commands)).toEqual([]);
  });

  it("説明の中の口は、数えない", () => {
    // **コメントには `./task db:up` が何度も出てくる**
    expect(queriesIn('# 直し方: x="$(./task db:up)"\n', commands)).toEqual([]);
  });

  it("口でない語は、数えない", () => {
    // **`task` で終わる語の次が、いつも口とは限らない**
    expect(queriesIn('now="$(cat "$task_log" | tail -1)"\n', commands)).toEqual([]);
  });
});
