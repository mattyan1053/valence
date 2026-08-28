import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-issue-descendants", import.meta.url));

/**
 * **親子はここでだけ決める**（#559 のレビュー）。
 *
 * **`bin/loop-claim idle`（止まっている親を鳴らさない）と
 * `bin/loop-in-progress-work`（人待ちの子 PR を親から引く）が、同じ問いを持っている**
 * ——**書き写すと、片方だけ直したときに食い違う。**
 *
 * **判定そのものは #544 / #545 で決めた**——**タイトルの末尾で結び、孫まで辿り、
 * 輪で止まる。** **ここはその引っ越し先**である。
 */
describe("割った親から、子孫を並べる", () => {
  const sandboxes: string[] = [];

  afterEach(() => {
    for (const dir of sandboxes.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** `gh` の身代わり。**Issue の一覧を返すだけ。** */
  function withIssues(
    titles: Record<number, string>,
    options: { fail?: boolean } = {},
  ): (args: string[]) => { status: number; stdout: string; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), "descendants-"));
    sandboxes.push(dir);
    const listed = Object.entries(titles)
      .map(([number, title]) => `${number}\t${title}`)
      .join("\n");
    writeFileSync(
      join(dir, "gh"),
      [
        "#!/usr/bin/env bash",
        ...(options.fail ? ["exit 1"] : []),
        // **`%b` で出す**——**`%s` だと `\\t` が literal のまま渡り、列が割れない**
        `printf '%b' ${JSON.stringify(listed === "" ? "" : `${listed}\n`)}`,
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(join(dir, "gh"), 0o755);
    return (args) => {
      const done = spawnSync(SCRIPT, args, {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      });
      return { status: done.status ?? -1, stdout: done.stdout.trim(), stderr: done.stderr };
    };
  }

  /** `reaches` の行だけを、`<親>\t<子孫>` に戻す。 */
  function reaches(out: string): string[] {
    return out
      .split("\n")
      .filter((line) => line.startsWith("reaches\t"))
      .map((line) => line.slice("reaches\t".length));
  }

  it("辺も出す", () => {
    // **鳴らす側は「どこで鎖が切れたか」まで言う**（#545）——**辿った結果だけでは
    // 足りない。** **同じ一覧から両方を出す**（**2 度引かない**）。
    const run = withIssues({ 542: "子（#540）", 544: "続き（#512 の続き）" });

    const listed = run([]).stdout.split("\n").sort();

    expect(listed, "辺を出していない").toEqual([
      "near\t542\t540",
      "near\t544\t512",
      "parent\t542\t540",
    ]);
  });

  it("子を並べる", () => {
    const run = withIssues({ 542: "図の箱に、PR のタイトルを出す（#540）" });

    expect(reaches(run(["540"]).stdout)).toEqual(["540\t542"]);
  });

  it("孫まで辿る", () => {
    // **割った先を、さらに割ってよい**（起票の規則）
    const run = withIssues({
      542: "そのうちの 1 つ（#540）",
      546: "さらに小さく（#542）",
    });

    expect(reaches(run(["540"]).stdout).sort()).toEqual(["540\t542", "540\t546"]);
  });

  it("括弧の中に語があるものは、結ばない", () => {
    // **`（#82 の前提）` は「#82 がこれを待つ」**であって、**その一部ではない**
    const run = withIssues({ 544: "何かの続き（#512 の続き）" });

    expect(reaches(run(["512"]).stdout), "括弧の中に語があるのに結んでいる").toEqual([]);
  });

  it("末尾でなければ、結ばない", () => {
    const run = withIssues({ 546: "（#540）の続きで、別のところを直す" });

    expect(reaches(run(["540"]).stdout), "末尾でない番号で結んでいる").toEqual([]);
  });

  it("輪になっていても、止まらずに答える", () => {
    // **タイトルは人が書く**ので、**A の子が B、B の子が A** は実在しうる
    const run = withIssues({ 546: "あれの続き（#547）", 547: "これの続き（#546）" });

    const done = run(["540"]);

    expect(done.status, "輪の中で止まっている").toBe(0);
    expect(reaches(done.stdout), "輪を親にぶら下げている").toEqual([]);
  });

  it("親自身は出さない", () => {
    // **呼ぶ側は「その Issue そのもの」を別に見ている**——**混ぜると 2 度数える**
    const run = withIssues({ 540: "親（#100）" });

    expect(reaches(run(["540"]).stdout)).toEqual([]);
  });

  it("複数の親を、それぞれ並べる", () => {
    const run = withIssues({ 542: "子（#540）", 602: "別の子（#600）" });

    expect(reaches(run(["540", "600"]).stdout).sort()).toEqual(["540\t542", "600\t602"]);
  });

  it("親を訊かれていなくても、辺は出す", () => {
    // **鳴らす側は辺だけで足りる**（**どこで切れたかを言う**。#545）
    // ——**`reaches` は訊かれた親のぶんだけ**である
    const run = withIssues({ 542: "子（#540）" });

    const listed = run([]);

    expect(listed.status).toBe(0);
    expect(listed.stdout, "辺を出していない").toContain("parent\t542\t540");
    expect(reaches(listed.stdout), "訊かれていない親を並べている").toEqual([]);
  });

  it("一覧を読めなければ、判定できないと言う", () => {
    // **読めないものを「子が無い」に倒さない**——**倒すと、親が黙って数から消える**
    const run = withIssues({ 542: "子（#540）" }, { fail: true });

    expect(run(["540"]).status).toBe(2);
    expect(run(["540"]).stderr).not.toBe("");
  });

  it("Issue 番号が読めなければ、使い方を出す", () => {
    const run = withIssues({});

    expect(run(["abc"]).status).toBe(2);
  });
});
