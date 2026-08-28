import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-in-progress-work", import.meta.url));

/** 列の区切り。**本物と同じ**（`bin/loop-open-work` が使っているもの）。 */
const FIELD = "\u001f";

type Pr = { number: number; branch: string; labels?: string[] };

function lines(prs: readonly Pr[]): string {
  return prs.map((pr) => [pr.number, pr.branch, ...(pr.labels ?? [])].join(FIELD)).join("\n");
}

function run(issues: readonly number[], input: string) {
  const done = spawnSync(SCRIPT, issues.map(String), { input, encoding: "utf8" });
  return { status: done.status ?? -1, stdout: done.stdout.trim(), stderr: done.stderr };
}

const WAITING = ["parked", "awaiting-human"];

/**
 * **人待ちの PR を持つ Issue を、着手中の数に入れない**（#558。**#546 の裏側**）。
 *
 * **#546 は PR の側を引いた。** **その PR を持つ Issue は `in-progress` のまま数に
 * 入り続ける**——**両方の手が空いても `no-work` が通らず、人が呼ばれない。**
 *
 * **境目は「その Issue の open PR が、全部人待ちか」**である。**1 本でも普通の open PR が
 * あるなら、そちらを進められる。** **PR がまだ無い `in-progress` は、誰かが実装している
 * 最中**なので、**これまでどおり数に入る**（**外すと、実装中なのに「尽きた」と数える**）。
 */
describe("着手を進められる in-progress を数える", () => {
  it("PR がまだ無い Issue は、これまでどおり数える", () => {
    // **実装している最中である**——**外すと、3 周で全ループが止まる**
    expect(run([501], "").stdout).toBe("1");
  });

  it("人待ちの PR しか持たない Issue は、数えない", () => {
    // **いまの盤面がこれ**（#501 の実装は #502 で、`parked` + `awaiting-human`）
    const listed = run([501], lines([{ number: 502, branch: "fix/501-count", labels: WAITING }]));

    expect(listed.stdout, "人待ちだけなのに数えている").toBe("0");
  });

  it("普通の open PR が 1 本でもあれば、数える", () => {
    // **そちらを進められる**——**引くと、進められる作業があるのに「尽きた」と数える**
    const listed = run(
      [501],
      lines([
        { number: 502, branch: "fix/501-count", labels: WAITING },
        { number: 503, branch: "fix/501-other" },
      ]),
    );

    expect(listed.stdout, "進められる PR があるのに数えていない").toBe("1");
  });

  it("`parked` だけの PR は、進められる側である", () => {
    // **先行 PR 待ちはループが解く**（`bin/loop-open-work` の判断）
    // ——**判定を書き写していないので、そちらの境目がそのまま効く**
    const listed = run(
      [501],
      lines([{ number: 502, branch: "fix/501-count", labels: ["parked"] }]),
    );

    expect(listed.stdout).toBe("1");
  });

  it("別の Issue の PR は、結び付けない", () => {
    // **枝の名前で結ぶ**（`bin/loop-claim idle` と同じ口）——**`Closes` を書かない PR が
    // ある**（#321）ので、**そちらでは結べない。**
    const listed = run([501], lines([{ number: 502, branch: "fix/999-other", labels: WAITING }]));

    expect(listed.stdout, "別の Issue の PR で数を引いている").toBe("1");
  });

  it("番号の前方一致で結ばない", () => {
    // **`fix/5011-...` は #501 の PR ではない**
    const listed = run([501], lines([{ number: 502, branch: "fix/5011-x", labels: WAITING }]));

    expect(listed.stdout, "前方一致で結んでいる").toBe("1");
  });

  it("複数の Issue を、それぞれ数える", () => {
    const listed = run(
      [501, 601],
      lines([
        { number: 502, branch: "fix/501-count", labels: WAITING },
        { number: 602, branch: "feat/601-x" },
      ]),
    );

    expect(listed.stdout).toBe("1");
  });

  it("空白を含む label があっても、列がずれない", () => {
    // **GitHub の label 名には空白を入れられる**——**空白で繋ぎ直すと、そこで列が割れる**
    const listed = run(
      [501],
      lines([{ number: 502, branch: "fix/501-count", labels: ["needs human", ...WAITING] }]),
    );

    expect(listed.stdout, "空白を含む label で列がずれている").toBe("0");
  });

  it("着手中が無ければ、0 を返す", () => {
    // **使い方の誤りではない**——**`in-progress` が 0 件の周回は普通にある**
    const listed = run([], "");

    expect(listed.status).toBe(0);
    expect(listed.stdout).toBe("0");
  });

  it("読めない行を、0 件へ倒さない", () => {
    // **飲み込むと「作業が尽きた」に化ける**——**人待ちでもないのに人が呼ばれる**
    const listed = run([501], "これは PR の一覧ではない");

    expect(listed.status).toBe(2);
    expect(listed.stderr).not.toBe("");
  });

  it("Issue 番号が読めなければ落ちる", () => {
    expect(spawnSync(SCRIPT, ["abc"], { input: "", encoding: "utf8" }).status).toBe(2);
  });

  it("使い方の案内が、いまの書式を言う", () => {
    // **契約が 2 箇所にある**（冒頭のコメントと `usage()`）——**書式を変えたとき、
    // 案内だけ前のまま残る**（#551 のレビュー）
    const usage = spawnSync(SCRIPT, ["abc"], { input: "", encoding: "utf8" }).stderr;

    expect(usage, "枝を案内していない").toContain("<枝>");
    expect(usage, "label の並べ方を案内していない").toContain("<label><US><label>");
  });
});
