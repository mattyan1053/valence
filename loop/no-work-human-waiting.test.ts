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

type Pr = { number: number; branch?: string; labels: string[] };

/** そのブロックが `gh` へ渡す `--jq` の式。 */
function expressionOf(block: string): string {
  const found = /--jq '([^']*)'/.exec(block);
  expect(found, "`--jq` の式が見つからない").not.toBeNull();
  return found?.[1] ?? "";
}

/**
 * **式のとおりに 1 行を組み立てる。**
 *
 * **読むのは 3 つだけ**——**どの列を、どの順で、何で繋ぐか。** **`.number` と
 * `.labels[].name` が式に出てくる順が、そのまま列の順**である（**入れ替えれば、
 * 出力も入れ替わる**）。**`join(",")` があれば label は 1 列に畳まれる。**
 *
 * **どちらの列も出てこない式は落とす**——**演じられないものを、演じたことにしない。**
 */
function renderAs(expression: string, prs: readonly Pr[]): string {
  const numberAt = expression.indexOf(".number");
  const labelsAt = expression.indexOf(".labels[].name");
  // **枝の列も式から読む** (#558)——**`bin/loop-in-progress-work` が Issue と結ぶのに
  // 要る**ので、**同じ一覧に 1 列増えた。** **式に無ければ出さない**
  // （**演じられないものを、演じたことにしない**）。
  const branchAt = expression.indexOf(".headRefName");
  expect(numberAt, "式が PR 番号を出していない").toBeGreaterThanOrEqual(0);
  expect(labelsAt, "式が label を出していない").toBeGreaterThanOrEqual(0);
  const joinsLabels = expression.includes('join(",")');

  return prs
    .map((pr) => {
      const labels = joinsLabels ? [pr.labels.join(",")] : pr.labels;
      // **式に出てくる順が、そのまま列の順**である
      const columns: { at: number; text: string }[] = [
        { at: numberAt, text: `${pr.number}` },
        ...labels.map((label) => ({ at: labelsAt, text: label })),
      ];
      if (branchAt >= 0) {
        columns.push({ at: branchAt, text: pr.branch ?? `fix/999-${pr.number}` });
      }
      return columns
        .sort((left, right) => left.at - right.at)
        .map((column) => column.text)
        .join(FIELD);
    })
    .join("\\n");
}

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

    // **式から、出す列を組み立てる**（#551 のレビュー 2 周目）。**部分文字列で
    // 分岐して決め打ちの行を返すと、列の順を入れ替える変異が素通りする**
    // ——**本物の `gh` は式のとおりに出す**ので、**列が逆なら `bin/loop-open-work` は
    // PR 番号を読めずに落ちる。**
    //
    // **本物の jq は通せない。** **`gh` そのものを偽物へ差し替えている**ので、
    // **`gh` 内蔵の jq には届かない**（**`gh` が jq の導入を要求しないのは、
    // 本物の `gh` を呼べるときの話である**）。**この容器に jq も無い**
    // （`bin/loop-fixup-lines.test.ts`）——**なので、式のうち「どの列を、どの順で、
    // 何で繋ぐか」だけを読んで演じる。** **読めない式は落とす**（`renderAs`）。
    const listed = renderAs(expressionOf(countingBlock()), prs).replaceAll("'", "'\\''");

    writeFileSync(
      join(stub, "gh"),
      ["#!/usr/bin/env bash", `printf '${listed === "" ? "" : `${listed}\\n`}'`, "exit 0", ""].join(
        "\n",
      ),
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

/**
 * **人待ちの PR を持つ Issue を、着手中の数に入れない**（#558。**#546 の裏側**）。
 *
 * **PR の側だけ引いても `no-work` は通らない**——**その PR を持つ Issue は
 * `in-progress` のまま数に入り続ける**（**実測: #501 / #502**）。
 *
 * **配線を見る。** **手順書のブロックをそのまま走らせ、本物の口を置く**
 * ——**`bin/loop-in-progress-work` を呼んでいなければ、数は減らない。**
 */
describe("人待ちの PR を持つ着手中", () => {
  /** ステップ 7 の 4 ブロック（取る / 数える を 2 組）。 */
  function stepBlocks(): string {
    const found = blocks(section("### 作業が尽きたとき")).filter(
      (chunk) =>
        chunk.includes("gh pr list") ||
        chunk.includes("bin/loop-open-work") ||
        chunk.includes("gh issue list") ||
        chunk.includes("bin/loop-in-progress-work"),
    );
    expect(found, "取る側と数える側が 2 組そろっていない").toHaveLength(4);
    return found.join("\n");
  }

  /** **`gh` は一覧を返すだけ**にして、**数える側は本物を置く。** */
  function countWorkable(
    prs: readonly Pr[],
    inProgress: readonly number[],
    /** `<番号> <TAB> <タイトル>`。**親子は末尾で結ぶ**ので、ここでは表題ごと渡す。 */
    issues: readonly string[] = [],
  ): string {
    const workspace = mkdtempSync(join(tmpdir(), "in-progress-work-"));
    try {
      const stub = join(workspace, "stub");
      mkdirSync(stub, { recursive: true });
      mkdirSync(join(workspace, "bin"), { recursive: true });
      // **親子を引く口も要る** (#559 のレビュー)——**数える側が呼ぶ**
      for (const name of ["loop-open-work", "loop-in-progress-work", "loop-issue-descendants"]) {
        copyFileSync(join(REPO_ROOT, "bin", name), join(workspace, "bin", name));
      }

      const listed = renderAs(expressionOf(stepBlocks()), prs).replaceAll("'", "'\\''");
      const numbers = inProgress.join("\\n");
      const titles = issues.join("\\n").replaceAll("'", "'\\''");
      writeFileSync(
        join(stub, "gh"),
        [
          "#!/usr/bin/env bash",
          // **どの一覧かで返し分ける**——**同じ `gh` が 3 度呼ばれる**
          // **親子を引くほうが先**（`--state all`）——**下の枝は `issue list` を
          // すべて拾う**ので、**順を入れ替えると番号の一覧がそちらへ流れる。**
          'if [[ $* == *"--state all"* ]]; then',
          `  printf '${titles === "" ? "" : `${titles}\\n`}'`,
          "  exit 0",
          "fi",
          'if [[ $* == *"issue list"* ]]; then',
          `  printf '${numbers === "" ? "" : `${numbers}\\n`}'`,
          "  exit 0",
          "fi",
          `printf '${listed === "" ? "" : `${listed}\\n`}'`,
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      writeFileSync(
        join(workspace, "bin/loop-stall"),
        ["#!/usr/bin/env bash", 'echo "stall $*" >&2', "exit 0", ""].join("\n"),
        { mode: 0o755 },
      );

      const result = spawnSync("bash", ["-c", stepBlocks()], {
        cwd: workspace,
        encoding: "utf8",
        env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
      });

      expect(result.status, result.stderr).toBe(0);
      // **最後の行が、着手を進められる件数**である
      return result.stdout.trim().split("\n").at(-1) ?? "";
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  it("人待ちの PR しか持たない Issue を、数に入れない", () => {
    // **いまの盤面がこれ**（#501 の実装は #502 で、`parked` + `awaiting-human`）
    const counted = countWorkable(
      [{ number: 502, branch: "fix/501-count", labels: ["parked", "awaiting-human"] }],
      [501],
    );

    expect(counted, "人待ちだけなのに数えている").toBe("0");
  });

  it("割った子の PR しか無い親を、数に入れない", () => {
    // **枝が名乗るのは子の番号**なので、**親の番号を持つ枝は 1 本も出ない**
    // ——**結べないと「PR がまだ無い＝実装中」へ倒れ、この口が消しに来た状態が残る。**
    // **実データの形である**（親 #540 / 子 #542「…（#540）」/ 枝 `feat/542-x`）。
    const counted = countWorkable(
      [{ number: 543, branch: "feat/542-x", labels: ["parked", "awaiting-human"] }],
      [540],
      ["542\t子の話（#540）"],
    );

    expect(counted, "割った親に結べていない").toBe("0");
  });

  it("PR がまだ無い Issue は、これまでどおり数える", () => {
    // **実装している最中である**——**外すと、3 周で全ループが止まる**
    expect(countWorkable([], [501]), "実装中の Issue を数から落としている").toBe("1");
  });

  it("数え方を書き写さずに、口を名指しする", () => {
    // **写すと、片方だけ古くなってもどちらも正しく見える**（`AGENTS.md` §5）
    expect(section("### 作業が尽きたとき"), "数える口を名指ししていない").toContain(
      "bin/loop-in-progress-work",
    );
  });

  it("条件の言い回しが、着手中の側も引いている", () => {
    // **残る側は自分の diff に出てこない**ので、**行で突き合わせる**（#546 と同じ形）
    // ——**1 箇所だけ直すと、起票の条件が開かないまま `no-work` だけが通る。**
    // **行で見ない**——**条件は折り返す**（**`in-progress` の節が次の行へ回る**）。
    // **数で突き合わせる**：**条件を言っている箇所と、着手中を引いている箇所が同じ数**。
    const text = procedureText("master");
    const conditions = text.split("\n").filter((line) => line.includes("open PR が 0 件")).length;
    const drawn = text.split("着手を進められる `in-progress`").length - 1;

    expect(conditions, "条件がどこにも無い（見出しか言い回しが変わった）").toBeGreaterThan(1);
    expect(drawn, "着手中から人待ちを引いていない条件がある").toBe(conditions);
  });
});
