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
 * 実行されない行を落とす——**コメントと、引用符付きのヒアドキュメントの中**（#427）。
 *
 * **`<<'区切り'` の中は展開されない**ので、**実行されない**——**案内としてコマンドの
 * 例を出すときに使う形**である。**拾うと、書いた人には理由の分からない赤が出る**
 * （**行末コメント・逃がした `$(` と同じ家族**。#425）。
 *
 * **区切りを引用符で囲まない形は落とさない**——**`$( )` が展開される**ので、
 * **実行される側**である。
 *
 * **1 度で回すのは、順序がどちらでも黙るから**である (#429 のレビュー)。
 * **ヒアドキュメントを先に見ると、`# 例: cat <<'EOF'` が始まりとして読まれ**、
 * **終わりが無ければ、その先の実コードが丸ごと消える**（**この見張りが黙る**）。
 * **コメントを先に落とすと、ヒアドキュメントの中の `#` まで切る**（**中身は文字列**）。
 * **中に居るかどうかで、掛けるものを変える。**
 *
 * **落とすのは中身だけ**（**終わりの行までで戻る**）——**終わりを読み違えると、
 * その先が丸ごと見えなくなる**（**空振りする側**）。
 *
 * **見ていないもの**（#429 のレビュー）。**向きごと書く**——**「赤が出る側」だけを
 * 並べると、黙る側の入口を見落としたことに気づけない**（**実際に見落とした**）:
 *
 *   - **赤が出る側**（**実行されない行を数える**。**踏んだ人には見える**）
 *     - **字下げされた終わりの行を、終わりとして扱う。** **bash が字下げを許すのは
 *       `<<-`（しかもタブだけ）**——**こちらは早く閉じるので、その先の中身を数える**
 *     - **1 行に 2 つ開く形**（`cat <<'A' <<'B'`）——**最初の 1 つしか見ない**
 *   - **黙る側**（**その先の実コードが消える**。**見えない**）
 *     - **逃がした `<<`**（`\<<'EOF'`）——**始まりとして読む**
 *
 * **黙る側は、出たら直す**（#429 の線引き）——**コメントの中・文字列の中・`<<<` は、
 * どれもこの一覧から降りている**（**入力を置いて塞いだ**）。
 *
 * **bash の規則を全部写さない。** **この見張りの目的は「fast path への入れ忘れを
 * 見つける」**であって、**shell を読むことではない**（#429 のレビュー）。
 */
/**
 * その行が開くヒアドキュメント。**開かないなら `null`。**
 *
 * **`<<` そのものは、引用符の外に無ければならない** (#429 のレビュー 2 周目)
 * ——**`echo "cat <<'EOF'"` は案内であって、開かない。** **区切り語のほうは
 * 引用符の中にある**（それが「展開しない」の印である）ので、
 * **伏字の上では位置だけを見て、語は元の行から読む。**
 *
 * **`<<<`（ヒアストリング）は別物**なので、**当てない**——**`<<<'文字列'` は
 * 2 文字目から `<<'文字列'` として一致する**（**書いてあったが、できていなかった**）。
 */
function heredocOpenedBy(line: string): { ending: string; dropping: boolean } | null {
  const at = /(?<!<)<<-?(?!<)/.exec(maskQuoted(line));
  if (at === null) {
    return null;
  }
  const opened = /^<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(line.slice(at.index));
  if (opened === null) {
    return null;
  }
  return { ending: opened[2] ?? "", dropping: (opened[1] ?? "") !== "" };
}

type Heredoc = { ending: string; dropping: boolean };

/** ヒアドキュメントの中に居るときの 1 行。**中身は文字列**（コメントとして落とさない）。 */
function insideHeredoc(line: string, state: Heredoc): string {
  if (line.trim() === state.ending) {
    state.ending = "";
    return line;
  }
  // **引用符付きの中身だけを落とす**（**展開される側は、そのまま数える**）
  return state.dropping ? "" : line;
}

function runnableLines(text: string): string[] {
  const state: Heredoc = { ending: "", dropping: false };
  return text.split("\n").map((line) => {
    if (state.ending !== "") {
      return insideHeredoc(line, state);
    }
    const code = withoutComment(line);
    const opened = heredocOpenedBy(code);
    if (opened !== null) {
      state.ending = opened.ending;
      state.dropping = opened.dropping;
    }
    return code;
  });
}

/**
 * その行から、コメントを落とす。**引用符の中は落とさない。**
 *
 * **行頭だけでは足りない** (#425 のレビュー)——**このリポジトリはコメントに例を書く**
 * ので、**`true # 例: x="$(./task doctor)"` と書いた人に、理由の分からない赤が出る。**
 * **当てる側だけを強めると、当ててはいけないものに当たる**（#394）。
 *
 * **`#` から行末までを素朴に落とすと、引用符の中の `#` まで切る**——
 * **`bin/` には `--format '{{.ID}}|{{.Label "…"}}'` のような行がある**ので、
 * **その行の呼び出しが丸ごと見えなくなる**（**空振りする側**）。
 *
 * **`#` がコメントを始めるのは、語の頭にあるときだけ**である（`x=a#b` は違う）。
 */
function withoutComment(line: string): string {
  const found = /(?:^|\s)#/.exec(maskQuoted(line));
  return found === null ? line : line.slice(0, found.index + found[0].length - 1);
}

/**
 * 引用符の中を、同じ長さの伏字にする。**位置が動かない**ので、
 * **見つけた位置で元の行を読める。**
 */
function maskQuoted(line: string): string {
  return line.replaceAll(/'[^']*'|"[^"]*"/g, (quoted) => "x".repeat(quoted.length));
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
  // **実行されない行を外す**——**コメントと、引用符付きのヒアドキュメントの中。**
  const code = runnableLines(text).join("\n");
  const found: string[] = [];
  // **逃がした `$(` は、実行されない** (#425 のレビュー)——**案内としてコマンドの例を
  // 文字列で出す行がある**（`bin/lint-shell` / `bin/loop-lease`）。
  for (const substitution of code.matchAll(/(?<!\\)\$\((?:[^()]|\([^()]*\))*\)/g)) {
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

  it("逃がした `$(` は、数えない", () => {
    // **文字列として出す例**である（**実行されない**）——**このリポジトリは、
    // 案内としてコマンドの例を文字列で出す**（`bin/lint-shell` / `bin/loop-lease`）。
    // **拾うと、書いた人には理由の分からない赤が出る**（#425 のレビュー）。
    expect(queriesIn('echo "使い方: \\$(./task doctor)" >&2\n', commands)).toEqual([]);
  });

  it("行末のコメントの中の口も、数えない", () => {
    // **当てる側だけを強めると、当ててはいけないものに当たる** (#394。#425 のレビュー)
    // ——**このリポジトリはコメントに例を書く**ので、**実行されない口を拾うと、
    // 書いた人には理由の分からない赤が出る。**
    expect(queriesIn('true # 例: x="$(./task doctor)"\n', commands)).toEqual([]);
  });

  it("引用符の中の `#` は、コメントとして落とさない", () => {
    // **`#` から行末までを素朴に落とすと、引用符の中の `#` まで切る**
    // ——**`bin/` には `--format '{{.ID}}|{{.Label "…"}}'` のような行がある**（#425 のレビュー）。
    // **落とすと、その行の呼び出しが丸ごと見えなくなる**（**空振りする側**）。
    // **語の頭に見える `#` を、引用符の中に置く**（**空白のあと**）
    // ——**そうでないと、伏字にしなくても切られない**（**当たらない入力になる**）。
    expect(
      queriesIn(`note='メモ #1'; paths="$("$TASK" loop:stop:paths)"\n`, commands),
      "引用符の中の # で切っている",
    ).toContain("loop:stop:paths");
  });

  it("引用符付きのヒアドキュメントの中は、数えない", () => {
    // **`<<'区切り'` の中は展開されない**ので、**実行されない**（#427）。
    // **案内としてコマンドの例を出す**ときに使う形である。
    const text = ["cat <<'USAGE'", '使い方: x="$(./task doctor)"', "USAGE", ""].join("\n");

    expect(queriesIn(text, commands)).toEqual([]);
  });

  it("展開されるヒアドキュメントの中は、数える", () => {
    // **区切りを引用符で囲まない形は `$( )` が展開される**ので、**実行される側**である
    const text = ["cat <<USAGE", "いま: $(./task doctor)", "USAGE", ""].join("\n");

    expect(queriesIn(text, commands), "展開される中身を数えていない").toContain("doctor");
  });

  it("コメントの中の記法では、ヒアドキュメントは始まらない", () => {
    // **黙る側である**（#429 のレビュー）——**終わりの行が無ければ、そこから先の
    // 実コードが丸ごと消える**。**新しい口が並びに無くても緑**になり、
    // **#424 が消しに来た状態そのもの**になる。
    const text = ["# 例: cat <<'USAGE'", 'port="$(./task doctor)"', ""].join("\n");

    expect(queriesIn(text, commands), "コメントで始まったことにして、その先を捨てている").toContain(
      "doctor",
    );
  });

  it("ヒアドキュメントの中の `#` は、コメントではない", () => {
    // **中身は文字列**である——**コメントとして落とすと、展開される口が消える**
    const text = ["cat <<USAGE", "# いま: $(./task doctor)", "USAGE", ""].join("\n");

    expect(queriesIn(text, commands), "中身をコメントとして落としている").toContain("doctor");
  });

  it("文字列の中の記法では、始まらない", () => {
    // **黙る側である**（コメントの中の記法と同じ形）——**案内としてコマンドの例を
    // 文字列で出す行がある**（`bin/lint-shell` / `bin/loop-lease`）ので、
    // **そこで始まったことにすると、その先の実コードが丸ごと消える。**
    const text = ["echo \"使い方: cat <<'USAGE'\"", 'port="$(./task doctor)"', ""].join("\n");

    expect(queriesIn(text, commands), "文字列の中で始まったことにしている").toContain("doctor");
  });

  it("ヒアストリング（`<<<`）では、始まらない", () => {
    // **黙る側である**（#429 のレビュー 2 周目）——**`<<<'文字列'` の 2 文字目から
    // `<<'文字列'` として一致し**、**単独の終わりの行は来ない**ので、
    // **その先の実コードが丸ごと消える。**
    //
    // **「当てていない」と書いてあった**（前の周回のこの試験の説明）——**書いたことと
    // できることが食い違うと、読む側の確認をすり抜ける。** **当ててみる。**
    const text = ["grep -q . <<<'USAGE'", 'port="$(./task doctor)"', ""].join("\n");

    expect(queriesIn(text, commands), "ヒアストリングで始まったことにしている").toContain("doctor");
  });

  it("区切りにハイフンが入っていても、始まりと読む", () => {
    // **`<<'END-USAGE'` は実在する書き方**である（#429 のレビュー）
    const text = ["cat <<'END-USAGE'", '使い方: x="$(./task doctor)"', "END-USAGE", ""].join("\n");

    expect(queriesIn(text, commands)).toEqual([]);
  });

  it("ヒアドキュメントが終われば、また数える", () => {
    // **落とすのは中身だけ**——**終わりを読み違えると、その先が丸ごと見えなくなる**
    const text = ["cat <<'USAGE'", "使い方", "USAGE", 'port="$(./task doctor)"', ""].join("\n");

    expect(queriesIn(text, commands), "終わったあとを数えていない").toContain("doctor");
  });

  it("口でない語は、数えない", () => {
    // **`task` で終わる語の次が、いつも口とは限らない**
    expect(queriesIn('now="$(cat "$task_log" | tail -1)"\n', commands)).toEqual([]);
  });
});
