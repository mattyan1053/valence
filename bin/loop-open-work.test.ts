/**
 * **着手できる open PR を数える**（#546）。
 *
 * **人待ちの PR が 1 本あるだけで、`no-work` が永久に通らなかった。**
 * **`parked` + `awaiting-human` は open PR なので数に入り**、**両方の手が空いていても
 * `loop/STOP` は置かれない**——**3 周で人を呼ぶ仕掛けが、呼ぶべき場面で働かない。**
 *
 * **`blocked` の Issue を数に入れないのと同じ理由**である（master の手順書）
 * ——**人の判断待ちで、ループの中では解けない。数を減らせるのは人だけ。**
 *
 * **判定はここが 1 つだけ持つ。** **手順書へ書き写さない**（`AGENTS.md` §5）。
 *
 * **モックを使わない**——**本物のスクリプトへ、本物と同じ形の入力を流す。**
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-open-work", import.meta.url));

/** 列の区切り。**本物と同じ**（`bin/loop-parked-issues` が使っているもの）。 */
const FIELD = "";

type Pr = { number: number; labels: string[] };

function lines(prs: readonly Pr[]): string {
  return prs.map((pr) => [pr.number, pr.labels.join(",")].join(FIELD)).join("\n");
}

function run(input: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(SCRIPT, { input, encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout.trim(), stderr: result.stderr };
}

describe("着手できる open PR を数える", () => {
  it("人待ちの PR は数に入れない", () => {
    // **人だけが解ける**——**`blocked` の Issue と同じ扱いである**
    expect(run(lines([{ number: 502, labels: ["parked", "awaiting-human"] }])).stdout).toBe("0");
  });

  it("先行 PR 待ちの保留は数に入れる", () => {
    // **`parked` だけはループが解く**——**外すと、先行 PR を待っているだけの周回で
    // 「尽きた」と数え始め、3 周で全ループが止まる**
    expect(run(lines([{ number: 502, labels: ["parked"] }])).stdout).toBe("1");
  });

  it("`awaiting-human` だけの PR も数に入れる", () => {
    // **保留されていない PR は、ゲートを回せる**——**片方だけで外さない**
    expect(run(lines([{ number: 502, labels: ["awaiting-human"] }])).stdout).toBe("1");
  });

  it("ふつうの open PR は数に入れる", () => {
    expect(run(lines([{ number: 545, labels: [] }])).stdout).toBe("1");
  });

  it("混ざっていれば、着手できるぶんだけ数える", () => {
    const listed = lines([
      { number: 502, labels: ["parked", "awaiting-human"] },
      { number: 545, labels: ["changes-requested"] },
      { number: 546, labels: [] },
    ]);

    expect(run(listed).stdout).toBe("2");
  });

  it("0 件でも 0 を返す", () => {
    // **呼ぶ側からは空文字が来る**（一覧が 0 件のとき）
    const listed = run("");

    expect(listed.status).toBe(0);
    expect(listed.stdout).toBe("0");
  });

  it("label が似ているだけの PR を、人待ちに数えない", () => {
    // **前方一致で見ない**——**`parked-later` のような label が付いた日に、
    // 着手できる PR が黙って数から消える**
    const listed = lines([{ number: 545, labels: ["parked-later", "awaiting-human-review"] }]);

    expect(run(listed).stdout).toBe("1");
  });

  it("最後の行に改行が無くても数える", () => {
    // **`read` は改行で終わっていない行を読むと非 0 を返す**——**そのまま条件にすると
    // 最後の 1 件が落ちる**（**PR が 1 本だけの周回は、まさにその 1 件**）
    expect(run(`545${FIELD}`).stdout).toBe("1");
  });

  it("読めない行を、0 件へ倒さない", () => {
    // **飲み込むと「作業が尽きた」に化ける**——**人待ちでもないのに人が呼ばれる**
    const listed = run("これは PR の一覧ではない");

    expect(listed.status).toBe(2);
    expect(listed.stderr).not.toBe("");
  });

  it("PR 番号が読めなければ落ちる", () => {
    expect(run(`abc${FIELD}parked`).status).toBe(2);
  });

  it("引数は取らない", () => {
    expect(spawnSync(SCRIPT, ["545"], { encoding: "utf8" }).status).toBe(2);
  });
});
