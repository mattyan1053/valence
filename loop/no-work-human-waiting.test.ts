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

    // **式のとおりに返す**（#551 のレビュー）。**書式を試験側で決め打ちすると、
    // `--jq` を元へ戻す変異が届かない**——**この PR が直したのは「生成側と解析側の
    // 書式が食い違う」ことなのに、その食い違いを起こせない試験になっていた。**
    //
    // **`gh --jq` は `gh` が持っている jq** で、**この容器には jq が無い**
    // （`bin/loop-fixup-lines.test.ts`）——**本物を通せない**ので、**知っている 2 つの
    // 書式だけを演じ、知らない式は落とす。**
    const render = (labels: (pr: Pr) => string[]) =>
      prs
        .map((pr) => [pr.number, ...labels(pr)].join(FIELD))
        .join("\\n")
        .replaceAll("'", "'\\''");
    const asFields = render((pr) => pr.labels);
    const asComma = render((pr) => (pr.labels.length === 0 ? [] : [pr.labels.join(",")]));
    const emit = (listed: string) => `printf '${listed === "" ? "" : `${listed}\\n`}'`;

    writeFileSync(
      join(stub, "gh"),
      [
        "#!/usr/bin/env bash",
        // **label を「取り出す」ところまで見る**（#313 と同じ形）。**`--json` に
        // 書いてあっても、`--jq` が落としていれば、数える側は判別できない**
        `[[ $* == *".labels[].name"* ]] || { echo "スタブ: label を取り出していない: $*" >&2; exit 1; }`,
        `if [[ $* == *'join(",")'* ]]; then`,
        `  ${emit(asComma)}`,
        `elif [[ $* == *'join("\\u001f")'* ]]; then`,
        `  ${emit(asFields)}`,
        "else",
        `  echo "スタブ: 知らない --jq の式: $*" >&2`,
        "  exit 1",
        "fi",
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

describe("同じ条件が、ほかにも書いてある", () => {
  /** **「open PR が 0 件」と言っている行を、全部並べる。** */
  function conditionLines(): string[] {
    return procedureText("master")
      .split("\n")
      .filter((line) => line.includes("open PR が 0 件"));
  }

  it("どの行も、人待ちを引いた数で言っている", () => {
    // **名指ししない**（#166）——**1 箇所だけ直して、同じ条件が別の節に残っていた**
    // （**起票の条件が開かないまま `no-work` だけ通り、3 周で人が呼ばれる**）。
    // **残る側は自分の diff に出てこない**ので、**行を数えて突き合わせる。**
    const found = conditionLines();

    expect(found.length, "条件がどこにも無い（見出しか言い回しが変わった）").toBeGreaterThan(1);
    for (const line of found) {
      expect(line, `人待ちを引いていない: ${line.trim()}`).toContain("着手できる open PR が 0 件");
    }
  });

  it("どの節も、数え方を書き写さずに口を名指しする", () => {
    // **写すと、片方だけ古くなってもどちらも正しく見える**（`AGENTS.md` §5）
    for (const heading of ["## 5. 作業を割って Issue にする", "### 作業が尽きたとき"]) {
      expect(section(heading), `${heading}: 数える口を名指ししていない`).toContain(
        "bin/loop-open-work",
      );
    }
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
