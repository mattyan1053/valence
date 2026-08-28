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

type Pr = { number: number; branch?: string; labels: string[] };

/**
 * **label も 1 つずつ列にする**（#550）。
 *
 * **カンマで繋がない**——**GitHub の label 名にはカンマを入れられる**ので、
 * **`parked,awaiting-human` という 1 つの label が、2 つに見える。**
 *
 * **`<US>` が入らないことは確かめていない**（**スクリプトの冒頭にも書いてある**）
 * ——**カンマよりは入りにくい**、までである。
 */
function lines(prs: readonly Pr[]): string {
  // **2 列目は枝である** (#558)——**同じ一覧を `bin/loop-in-progress-work` も回す**ので、
  // **列が 1 つ増えた。** **この口は使わないが、読み飛ばす位置は合っていること。**
  return prs
    .map((pr) => [pr.number, pr.branch ?? `fix/999-${pr.number}`, ...pr.labels].join(FIELD))
    .join("\n");
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

  it("カンマを含む 1 つの label を、2 つの label と見ない", () => {
    // **GitHub の label 名にはカンマを入れられる**（#550）——**繋いでから
    // 部分一致で見ると、`parked,awaiting-human` という名前の label が付いた
    // ふつうの PR が、人待ちとして数から消える**（**そのまま `no-work` が積まれる**）
    const listed = lines([{ number: 545, labels: ["parked,awaiting-human"] }]);

    expect(run(listed).stdout).toBe("1");
  });

  it("label が似ているだけの PR を、人待ちに数えない", () => {
    // **前方一致で見ない**——**`parked-later` のような label が付いた日に、
    // 着手できる PR が黙って数から消える。**
    //
    // **片側ずつ確かめる。** **両方とも似た名前にすると、片方だけ前方一致で見る
    // 実装が生き残る**（**実際に生き残った**）——**もう片方が付いていないので、
    // どちらにせよ人待ちにならない。**
    expect(
      run(lines([{ number: 545, labels: ["parked-later", "awaiting-human"] }])).stdout,
      "`parked` を前方一致で見ている",
    ).toBe("1");
    expect(
      run(lines([{ number: 545, labels: ["parked", "awaiting-human-review"] }])).stdout,
      "`awaiting-human` を前方一致で見ている",
    ).toBe("1");
  });

  it("最後の行に改行が無くても数える", () => {
    // **`read` は改行で終わっていない行を読むと非 0 を返す**——**そのまま条件にすると
    // 最後の 1 件が落ちる**（**PR が 1 本だけの周回は、まさにその 1 件**）
    expect(run(`545${FIELD}fix/999-545`).stdout).toBe("1");
  });

  it("読めない行を、0 件へ倒さない", () => {
    // **飲み込むと「作業が尽きた」に化ける**——**人待ちでもないのに人が呼ばれる**
    const listed = run("これは PR の一覧ではない");

    expect(listed.status).toBe(2);
    expect(listed.stderr).not.toBe("");
  });

  it("PR 番号が読めなければ落ちる", () => {
    expect(run(`abc${FIELD}fix/999-1${FIELD}parked`).status).toBe(2);
  });

  it("引数は取らない", () => {
    expect(spawnSync(SCRIPT, ["545"], { encoding: "utf8" }).status).toBe(2);
  });

  it("使い方の案内が、いまの書式を言う", () => {
    // **契約が 2 箇所にある**（冒頭のコメントと `usage()`）——**書式を変えたとき、
    // 案内だけ前のまま残っていた**（#551 のレビュー）。**案内どおり打ち直すと、
    // この直しが消える**——**繋いだ文字列を渡す形へ戻る。**
    const usage = spawnSync(SCRIPT, ["545"], { encoding: "utf8" }).stderr;

    expect(usage, "区切りを案内していない").toContain("<label><US><label>");
    expect(usage, "枝の列を案内していない").toContain("<枝>");
    expect(usage, "案内が前の書式のまま").not.toContain("カンマ");
  });
});
