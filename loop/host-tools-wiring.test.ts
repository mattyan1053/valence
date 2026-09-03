/**
 * **ホストで走るものは、`git` 以外の道具を要求しない**（#383）。
 *
 * **このリポジトリは「ホストには何もインストールしない」と決めている**（`AGENTS.md` §2）
 * ——**`sha256sum` があることを前提にできない。** **いま動いているのは、この VM に
 * たまたま入っているから**である。
 *
 * **#220 が `flock` で同じことを踏んでいる**——**「あると思っていたものが無い」は、
 * 別の機械に置いた日に出る。** **`bin/loop-lease` と `bin/loop-procedure-stamp` は
 * 入口で必ず通る**ので、**無ければ周回が 1 つも始まらない。**
 *
 * **同じ判断を 4 度している**（#195 / #282 / #382 / #383）——**名前で見て、戻らないようにする。**
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN_DIR = join(REPO_ROOT, "bin");

/** ホストで走る bash。**`bin/` の中身と `./task`**（**試験は bash ではない**）。 */
function hostScripts(): string[] {
  const scripts = readdirSync(BIN_DIR)
    .filter((name) => !name.endsWith(".test.ts") && statSync(join(BIN_DIR, name)).isFile())
    .map((name) => join("bin", name));
  return [...scripts, "task"];
}

/**
 * **実行の位置だけを残す**（#599 のレビュー）。
 *
 * **コメントを落とすだけでは足りない**——**`echo "date -d が使えません"` のような
 * メッセージにも名前が出る**（**`date -d` は 9 行のうち 2 行がそれだった**）。
 * **実行を全部消してもメッセージだけで緑になり、逆方向の検出が働かない。**
 *
 * **`"..."` の中でも `$( )` は実行である**——**丸ごと落とすと、今度は
 * `"$(date -u +%s)"` を見落とす**（**測って確かめた。落としたら `date -u` が 0 になった**）。
 *
 * **`AGENTS.md` §4 の 10 回目**である。**`\btimeout\b` が `timeout-minutes` に
 * 食い込むのは自分で見つけたのに、`date -d` で同じことをした**——**数えるのは書く前。**
 */
type Scan = { out: string; at: number };

/** 単引用符の中。**置き換えは無いので、閉じるまで丸ごと落とす。** */
function skipSingle(text: string, from: number): Scan {
  let out = "";
  let at = from;
  for (; at < text.length && text[at] !== "'"; at++) {
    if (text[at] === "\n") {
      out += "\n";
    }
  }
  return { out, at };
}

/** 二重引用符の中。**`$( )` だけは実行なので、そこへ潜る。** */
function skipDouble(text: string, from: number): Scan {
  let out = "";
  let at = from;
  while (at < text.length && text[at] !== '"') {
    if (text[at] === "\\") {
      at += 2;
      continue;
    }
    if (text[at] === "$" && text[at + 1] === "(") {
      const inner = scanCode(text, at + 2, true);
      out += ` ${inner.out} `;
      at = inner.at + 1;
      continue;
    }
    if (text[at] === "\n") {
      out += "\n";
    }
    at += 1;
  }
  return { out, at };
}

/** 括弧の深さの増減。**`$( )` の対応を数えるためだけに要る。** */
function nesting(char: string): number {
  if (char === "(") {
    return 1;
  }
  return char === ")" ? -1 : 0;
}

/** 引用符の中を飛ばす。**単引用符は丸ごと、二重引用符は `$( )` だけ残す。** */
function skipQuoted(text: string, quote: string, from: number): Scan {
  return quote === "'" ? skipSingle(text, from) : skipDouble(text, from);
}

/** 実行の位置。**`nested` なら、対応する `)` で戻る。** */
function scanCode(text: string, from: number, nested: boolean): Scan {
  let out = "";
  let depth = 0;
  let at = from;
  for (; at < text.length; at++) {
    const char = text[at] ?? "";
    if (char === "'" || char === '"') {
      const inner = skipQuoted(text, char, at + 1);
      out += ` ${inner.out} `;
      at = inner.at;
      continue;
    }
    if (char === ")" && nested && depth === 0) {
      return { out, at };
    }
    depth += nesting(char);
    out += char;
  }
  return { out, at };
}

function executablePartsOf(text: string): string {
  return scanCode(text, 0, false).out;
}

/** コメントと文字列を落とした本文。**理由やメッセージの中の名前を数えない**（§4）。 */
function codeOf(path: string): string {
  return executablePartsOf(
    readFileSync(join(REPO_ROOT, path), "utf8")
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n"),
  );
}

/**
 * **知っている「POSIX に無い使い方」**（#595）。**分類を持たない項目を置かない。**
 *
 *   - `allowed` …… **使っている。理由がある**——**使われなくなったら落ちる**（宣言が古くなる）
 *   - `absent`  …… **使っていない。使うなら、ここへ理由ごと足す**——**黙って増やせない**
 *
 * **数えてから書いた**（#595）。**`date -d` は 5 ファイルで既に使っていた**——
 * **#594 が入れたものではない。**
 */
const WATCHED: { name: string; pattern: RegExp; use: "allowed" | "absent"; why: string }[] = [
  {
    name: "date -d",
    pattern: /\bdate\s+-d\b/,
    use: "allowed",
    why: "GitHub の ISO8601 を秒へ直す。GNU 拡張だが、5 ファイルが既に使う（数えた）",
  },
  { name: "date -u", pattern: /\bdate\s+-u\b/, use: "allowed", why: "記録の時刻を UTC で揃える" },
  {
    name: "stat -c",
    pattern: /\bstat\s+-c\b/,
    use: "allowed",
    why: "ファイルの更新時刻。stat 自体が POSIX に無いが、Linux 固定である",
  },
  { name: "base64 -d", pattern: /\bbase64\s+-d\b/, use: "allowed", why: "GitHub API の本文を戻す" },
  {
    name: "flock",
    pattern: /\bflock\s+-/,
    use: "allowed",
    why: "周回の直列化そのもの。#220 で「無い機械」を踏んでいる——sha256sum (#383) と同じ重み",
  },
  {
    name: "mktemp",
    pattern: /\bmktemp\b/,
    use: "allowed",
    why: "作業用の一時ファイル。POSIX に無い",
  },
  {
    name: "sha256sum",
    pattern: /\bsha256sum\b/,
    use: "absent",
    why: "#383。git hash-object --stdin で取る（git は既に必須）——判定を写さず、同じ手を使う",
  },
  {
    name: "readlink -f",
    pattern: /\breadlink\s+-f\b/,
    use: "absent",
    why: "task の冒頭が「GNU 依存なので使わない」と書いている（#595。書いてあるのに、機械が見ていなかった）",
  },
];
/**
 * ## この試験が見ていないもの（#595）
 *
 * **知らない道具が増えても、捕まえません。** **見るのは上の一覧に載っている名前だけ**で、
 * **「ホストが呼ぶ外部コマンドを全部並べる」ことはしていません。**
 *
 * **一度やってみて、やめました**——**命令の位置に立つ語を抜く形は、`case` のラベルや
 * 変数名まで拾い**、**逆に取りこぼしも起こりえます**（**シェルを本気で解析しないと
 * 健全になりません**）。**偽陰性を抱えたまま「全部見ている」と書くほうが高くつく**
 * ——**それがこの Issue の出どころ**です。
 *
 * **新しい道具に気づくのは、いまも人**です。**気づいたら、上の一覧へ足してください。**
 *
 * ## 何を載せるか（#599 のレビュー）
 *
 * **載せるのは「前提として宣言していないのに、実際に要求しているもの」**です。
 *
 * **載せない**——**`git` / `gh` / `docker` / `pnpm` / `node`。** **どれも
 * `AGENTS.md` と `./task` が前提として宣言している**ので、**無ければ最初の 1 行で分かる。**
 *
 * **載せる**——**`flock` がまさにそれ**で、**だから #220 で踏みました。**
 * **`date -d` のような拡張オプションも同じ**です——**道具はあるのに、その使い方だけが無い。**
 */
describe("ホストで走るスクリプトの道具", () => {
  it("メッセージに書いただけの名前は、使ったと数えない", () => {
    // **実行を全部消してもメッセージだけで緑になっていた**（#599 のレビュー）
    // ——**`date -d` は 9 行のうち 2 行がメッセージ**だった。
    const source = 'echo "[FAIL] 時刻を作れません（date -d が使えません）" >&2';

    expect(executablePartsOf(source), "メッセージの中まで数えている").not.toMatch(/date\s+-d/);
  });

  it("二重引用符の中でも、`$( )` は実行である", () => {
    // **丸ごと落とすと、今度は見落とす**——**測ったら `date -u` が 0 になった。**
    const source = "printf '%s' \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"";

    expect(executablePartsOf(source), "実行を落としている").toMatch(/date\s+-u/);
  });

  it("単引用符の中は、実行ではない", () => {
    const source = "printf '%s' 'sha256sum'";

    expect(executablePartsOf(source), "単引用符の中まで数えている").not.toMatch(/sha256sum/);
  });

  it("宣言した使い方は、いまも使われている", () => {
    // **古くなった宣言は、見張っているつもりで何も見ていない。**
    const gone = WATCHED.filter((tool) => tool.use === "allowed").filter(
      (tool) => !hostScripts().some((path) => tool.pattern.test(codeOf(path))),
    );

    expect(
      gone.map((tool) => tool.name),
      "宣言されているのに、もう使われていない（一覧から外すこと）",
    ).toEqual([]);
  });

  it("宣言していない使い方は、増えていない", () => {
    // **`sha256sum` はここに畳んである**（#383）——**判定を 2 箇所に持たない**（§5）。
    const added = WATCHED.filter((tool) => tool.use === "absent").flatMap((tool) =>
      hostScripts()
        .filter((path) => tool.pattern.test(codeOf(path)))
        .map((path) => `${path}: ${tool.name}`),
    );

    expect(added, "使わないと決めた道具が増えている（理由ごと一覧へ足すこと）").toEqual([]);
  });
});
