/**
 * **保留した PR が食っている「着手中」の枠を数える** (#318)。
 *
 * **`Closes` を書かない保留 PR だと、その Issue は `in-progress` のまま残る。**
 * **割った PR は親 Issue を閉じない**（**途中の 1/3 が入った時点で親が閉じてしまう**）
 * ので、**手順書が勧めている運用そのものが、この状態を必ず作る。**
 *
 * **判定はここが 1 つだけ持つ。** **出口（`bin/loop-handoff`）と master の手順書が
 * 同じ数え方をしていた**ので、**片方だけ直すと食い違う**（`AGENTS.md` §5）。
 *
 * **モックを使わない**——**本物のスクリプトへ、本物と同じ形の入力を流す。**
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-parked-issues", import.meta.url));

/** 列の区切り。**本物と同じ**（`bin/loop-handoff` が使っているもの）。 */
const FIELD = "\u001f";

type Pr = { number: number; labels: string[]; body: string };

function lines(prs: readonly Pr[]): string {
  return prs.map((pr) => [pr.number, pr.labels.join(","), pr.body].join(FIELD)).join("\n");
}

function run(input: string): { status: number; stdout: string[]; stderr: string } {
  const result = spawnSync(SCRIPT, { input, encoding: "utf8" });
  return {
    status: result.status ?? -1,
    stdout: result.stdout.split("\n").filter((line) => line !== ""),
    stderr: result.stderr,
  };
}

describe("保留した PR が食っている枠を数える", () => {
  it("`Closes` があれば、その Issue を挙げる", () => {
    // **これまでの形。** **書いてある PR は、これまでどおり引ける**
    const listed = run(lines([{ number: 317, labels: ["parked"], body: "Closes #315" }]));

    expect(listed.status).toBe(0);
    expect(listed.stdout).toEqual(["315"]);
  });

  it("`Closes` が無くても、枠は食っている", () => {
    // **割った PR は親を閉じない**ので、**書いていないほうが普通**である
    // ——**ここで 0 件にすると、その Issue は「着手中」のまま数え続けられる**
    const listed = run(lines([{ number: 317, labels: ["parked", "awaiting-human"], body: "" }]));

    expect(listed.status).toBe(0);
    expect(listed.stdout, "保留 PR を 1 件も数えていない").toHaveLength(1);
  });

  it("番号が分からないことは、分かる形で出す", () => {
    // **「引く」ことと「どれを引いたか」は別**——**番号を騙らない**
    const listed = run(lines([{ number: 317, labels: ["parked"], body: "" }]));

    expect(listed.stdout[0], "分からない枠が Issue 番号に化けている").toContain("317");
    expect(listed.stdout[0]).not.toMatch(/^[0-9]+$/);
  });

  it("保留でない PR は数えない", () => {
    // **`parked` だけが対象**——**進んでいる PR の Issue は着手中のままでよい**
    const listed = run(
      lines([
        { number: 316, labels: [], body: "Closes #314" },
        { number: 320, labels: ["changes-requested"], body: "Closes #319" },
      ]),
    );

    expect(listed.status).toBe(0);
    expect(listed.stdout).toEqual([]);
  });

  it("同じ Issue を指す保留 PR が 2 本あっても、枠は 1 つ", () => {
    // **引きすぎない側の担保。** **同じ Issue を 2 回引くと、着手中が負に振れる**
    const listed = run(
      lines([
        { number: 317, labels: ["parked"], body: "Closes #315" },
        { number: 321, labels: ["parked"], body: "Closes #315" },
      ]),
    );

    expect(listed.stdout).toEqual(["315"]);
  });

  it("1 本で 2 件閉じるなら、2 件挙げる", () => {
    const listed = run(
      lines([{ number: 317, labels: ["parked"], body: "Closes #315 と Closes #316 を閉じる" }]),
    );

    expect(listed.stdout.sort()).toEqual(["315", "316"]);
  });

  it("1 件も無ければ、0 件を返す", () => {
    // **「0 件」と「読めなかった」を分ける**ための、正常な 0 件
    const listed = run("");

    expect(listed.status).toBe(0);
    expect(listed.stdout).toEqual([]);
  });

  it("読めない行が来たら、0 件に倒さない", () => {
    // **判定不能を「保留は無い」に化けさせない**（`AGENTS.md` §5）——
    // **化けると、着手中が引かれないまま「渡すものがある」に見える**
    const listed = run("317 parked Closes #315");

    expect(listed.status, "読めない行を 0 件として飲み込んでいる").toBe(2);
    expect(listed.stderr).not.toBe("");
  });
});
