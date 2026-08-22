/**
 * **`./task check` が終わったかどうかを、記録として残す**（#375）。
 *
 * **2 つの作業場が、別々の日に同じ罠を踏んだ**——**「終わったこと」を読み違えた。**
 * **印（`check-exit=<合否>`）は終わったときにしか書かれない**（`task` の `cmd_check` は
 * `exec_app pnpm check` が返ってから `echo` する）——**足りないのは、読む側を
 * 強いるもの**である。
 *
 * **記録は作業場ごと**（`git rev-parse --git-dir`）。**共通ディレクトリではない**
 * ——**別の作業場の check は、こちらの commit の可否と関係が無い。**
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-check-state", import.meta.url));

describe("bin/loop-check-state", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "check-state-"));
    expect(spawnSync("git", ["init", "--quiet", repo]).status).toBe(0);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function run(args: string[]): { status: number; stdout: string; stderr: string } {
    const result = spawnSync(SCRIPT, args, { cwd: repo, encoding: "utf8" });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  /** 記録の置き場所。**作業場ごと**である。 */
  function statePath(): string {
    return join(repo, ".git", "valence-check-state");
  }

  it("記録が無ければ、4 を返す", () => {
    // **「無い」と「赤」を混ぜない**——**打っていない人を止める口ではない**
    expect(run(["--verdict"]).status).toBe(4);
  });

  it("走り始めたら、まだ終わっていないと答える", () => {
    expect(run(["running"]).status).toBe(0);

    expect(run(["--verdict"]).status, "走っている最中を読めていない").toBe(3);
  });

  it("緑で終わったら、0 を返す", () => {
    run(["running"]);
    expect(run(["done", "0"]).status).toBe(0);

    expect(run(["--verdict"]).status).toBe(0);
  });

  it("赤で終わったら、1 を返す", () => {
    run(["running"]);
    run(["done", "1"]);

    expect(run(["--verdict"]).status).toBe(1);
  });

  it("殺された周回は、走っているままになる", () => {
    // **これが本体である。** **`done` を書けずに終わった check**——
    // **「終わっていない」と読めなければ、途中のログを緑と読む**
    run(["running"]);

    expect(run(["--verdict"]).status, "殺された周回を「終わった」と読んでいる").toBe(3);
  });

  it("知らない形は、読めない側へ倒す", () => {
    writeFileSync(statePath(), "なにか\n");

    expect(run(["--verdict"]).status).toBe(2);
  });

  it("使い方の誤りは、通す側に倒さない", () => {
    expect(run([]).status).toBe(2);
    expect(run(["done"]).status).toBe(2);
    expect(run(["done", "合否"]).status).toBe(2);
    expect(run(["walking"]).status).toBe(2);
  });

  it("記録は作業場ごとに置く", () => {
    // **共通ディレクトリに置くと、別の作業場の check がこちらの可否を決める**
    run(["running"]);

    expect(existsSync(statePath()), "作業場の外に置いている").toBe(true);
    expect(readFileSync(statePath(), "utf8"), "何が起きたかが読めない").toContain("running");
  });
});
