/**
 * **人待ちの PR が 1 本あるだけで、`no-work` が永久に通らない**（#546）。
 *
 * **`parked` + `awaiting-human` の PR は open PR である。** **数に入れると条件が
 * 成立せず**、**両方の手が空いていても `loop/STOP` は置かれない**——**3 周で人を呼ぶ
 * 仕掛けが、呼ぶべき場面で働かない**（#312 / #313 と同じ形が、PR 側に開いていた）。
 *
 * **散文だけでは足りない**（#313 のレビュー）。**「人待ちは数に入れない」と書いても、
 * 打つコマンドが label を取っていなければ、実行する側に判別する材料が無い**
 * ——**ここでは、手順書のブロックを実際に走らせて見る。**
 *
 * **判定そのものは `bin/loop-open-work` が持つ**（`AGENTS.md` §5）。
 * **ここで見るのは、手順書がその口へ繋がっているか**である。
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { procedureText } from "./procedure-doc";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 列の区切り。**本物と同じ**（`bin/loop-open-work` が読む形）。 */
const FIELD = "";

/** その節の bash ブロック（**打つところで見る**）。 */
function blocks(text: string): string[] {
  return text
    .split("```bash")
    .slice(1)
    .map((chunk) => chunk.split("```")[0] ?? "");
}

/** 見出しで区切った 1 節（**節の外の散文で条件が満たされない**ようにする）。 */
function section(heading: string): string {
  const after = procedureText("master").split(heading)[1] ?? "";
  return after.split(/\n#{2,4} /)[0] ?? "";
}

/**
 * 「作業が尽きたとき」で、**取る側と数える側**のブロック。
 *
 * **2 つに分かれている**（`bin/loop-parked-issues` と同じ形。**取れた一覧をそのまま
 * 出しておけば、数え方が変わっても「何を見て決めたか」は残る**）——**続けて走らせる。**
 */
function countingBlock(): string {
  const found = blocks(section("### 作業が尽きたとき")).filter(
    (chunk) => chunk.includes("gh pr list") || chunk.includes("bin/loop-open-work"),
  );
  expect(found, "取る側と数える側が揃っていない").toHaveLength(2);
  return found.join("\n");
}

type Pr = { number: number; labels: string[] };

/**
 * そのブロックを、偽の `gh` で走らせる。
 *
 * **`gh` は一覧を返すだけ**にして、**数える側は本物を置く**——**見たいのは
 * 「手順書が本物の口へ繋がっているか」**である。
 */
function countWith(prs: readonly Pr[]): string {
  const workspace = mkdtempSync(join(tmpdir(), "no-work-"));
  try {
    const stub = join(workspace, "stub");
    mkdirSync(stub, { recursive: true });
    mkdirSync(join(workspace, "bin"), { recursive: true });
    copyFileSync(join(REPO_ROOT, "bin/loop-open-work"), join(workspace, "bin/loop-open-work"));

    const listed = prs
      .map((pr) => `${pr.number}${FIELD}${pr.labels.join(",")}`)
      .join("\\n")
      .replaceAll("'", "'\\''");
    writeFileSync(
      join(stub, "gh"),
      [
        "#!/usr/bin/env bash",
        // **label を「取り出す」ところまで見る**（#313 と同じ形）。**`--json` に
        // 書いてあっても、`--jq` が落としていれば、数える側は判別できない**
        // ——**そこを見ないと、列を削る変異が生き残る**（**実際に生き残った**）
        `[[ $* == *".labels[].name"* ]] || { echo "スタブ: label を取り出していない: $*" >&2; exit 1; }`,
        `printf '${listed === "" ? "" : `${listed}\\n`}'`,
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    // **落ちたら停止を積む側も偽物にする**（本物を呼ぶと、試験がカウンタを動かす）
    writeFileSync(
      join(workspace, "bin/loop-stall"),
      ["#!/usr/bin/env bash", 'echo "stall $*" >&2', "exit 0", ""].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync("bash", ["-c", countingBlock()], {
      cwd: workspace,
      encoding: "utf8",
      env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
    });

    expect(result.status, `ブロックが落ちた: ${result.stderr}`).toBe(0);
    // **取った一覧も表に出る**（**そういう決まりである**——`loop/lookup-failure-wiring`）
    // ので、**数えた結果は最後の行**である
    const printed = (result.stdout ?? "").split("\n").filter((line) => line !== "");
    return printed[printed.length - 1] ?? "";
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

describe("人待ちの PR しか無いとき", () => {
  it("人待ちの PR を、着手できる数に入れない", () => {
    // **人だけが解ける**——**Issue 側の `blocked` と同じ扱い**である
    // （**数を減らせるのは人だけ**）
    expect(countWith([{ number: 502, labels: ["parked", "awaiting-human"] }])).toBe("0");
  });

  it("先行 PR 待ちの保留は、これまでどおり数に入れる", () => {
    // **`parked` だけはループが解く**——**外すと、先行 PR を待っているだけの周回で
    // 「尽きた」と数え始め、3 周で全ループが止まる**
    expect(countWith([{ number: 502, labels: ["parked"] }])).toBe("1");
  });

  it("ふつうの open PR は、これまでどおり数に入れる", () => {
    expect(countWith([{ number: 545, labels: [] }])).toBe("1");
  });

  it("人待ちと、ふつうの PR が混ざっていれば、ふつうのぶんだけ数える", () => {
    expect(
      countWith([
        { number: 502, labels: ["parked", "awaiting-human"] },
        { number: 545, labels: [] },
      ]),
    ).toBe("1");
  });

  it("open PR が 0 件でも落ちない", () => {
    expect(countWith([])).toBe("0");
  });
});

describe("止まる向き", () => {
  // **口を名指ししているか**は、上の `countingBlock()` が見ている（**そこが本物の配線**）
  // ——**同じことを散文で 2 度見ない**（**片方は必ず通るので、測れていない**）
  it("人待ちのまま 3 周すると止まる、と書いてある", () => {
    // **`no-work` は 3 周で `loop/STOP` を置く**（#546）——**人待ちが長引く盤面では
    // 早く止まる。** **それが狙いだが、倒れる向きを読み手が知らないと事故に見える**
    expect(section("### 作業が尽きたとき"), "倒れる向きが書いていない").toContain(
      "人待ちが残ったまま",
    );
  });
});
