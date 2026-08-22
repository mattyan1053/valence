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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  /** 記録の置き場所。**作業場ごと**で、**走るたびに 1 つ**である (#130 と同じ形)。 */
  function statePath(): string {
    return join(repo, ".git", "valence-check-state.d");
  }

  it("記録が無ければ、4 を返す", () => {
    // **「無い」と「赤」を混ぜない**——**打っていない人を止める口ではない**
    expect(run(["--verdict"]).status).toBe(4);
  });

  it("走り始めたら、まだ終わっていないと答える", () => {
    expect(run(["running", "A"]).status).toBe(0);

    expect(run(["--verdict"]).status, "走っている最中を読めていない").toBe(3);
  });

  it("緑で終わったら、0 を返す", () => {
    run(["running", "A"]);
    expect(run(["finished", "A", "0"]).status).toBe(0);

    expect(run(["--verdict"]).status).toBe(0);
  });

  it("赤で終わったら、1 を返す", () => {
    run(["running", "A"]);
    run(["finished", "A", "1"]);

    expect(run(["--verdict"]).status).toBe(1);
  });

  it("殺された周回は、走っているままになる", () => {
    // **これが本体である。** **`done` を書けずに終わった check**——
    // **「終わっていない」と読めなければ、途中のログを緑と読む**
    run(["running", "A"]);

    expect(run(["--verdict"]).status, "殺された周回を「終わった」と読んでいる").toBe(3);
  });

  it("2 本走っていたら、片方が終わっても「走っている」", () => {
    // **これが本体である** (#376 のレビュー)。**記録が 1 つだと、後から終わったほうが
    // 上書きし**、**まだ走っている側が見えなくなる**——**2 本走るのは、この
    // リポジトリが既に前提にしている**（#130 が出力先を実行ごとに分けたのがそれ）。
    run(["running", "A"]);
    run(["running", "B"]);
    run(["finished", "B", "0"]);

    expect(run(["--verdict"]).status, "まだ走っている側が消えている").toBe(3);

    run(["finished", "A", "0"]);

    expect(run(["--verdict"]).status, "両方終わったのに緑にならない").toBe(0);
  });

  it("走り始めたら、前の合否は捨てる", () => {
    // **前の周回の緑で、いまの commit を通さない**——**木はもう変わっている**
    run(["running", "A"]);
    run(["finished", "A", "0"]);
    run(["running", "B"]);

    expect(run(["--verdict"]).status, "前の合否が残っている").toBe(3);
  });

  it("殺された周回の記録は、次の走りが片付ける", () => {
    // **これが無いと、出られない** (#184 の形)。**殺された周回は `finished` を
    // 書けない**ので記録は残る——**そのままだと、何度 check を走らせても
    // 「走っている」のまま**で、**commit が永久に止まる。**
    //
    // **id は `./task` の PID である**（`task` がそう渡す）——**生きていない PID の
    // 記録は、走り終えた周回のものではありえない。**
    run(["running", "999999"]); // **死んだ PID**（殺された周回の跡）
    run(["running", "A"]);
    run(["finished", "A", "0"]);

    expect(run(["--verdict"]).status, "殺された跡が残って、出られない").toBe(0);
  });

  it("生きている周回の記録は、片付けない", () => {
    // **緩めすぎない側**——**走っている相手を消すと、この Issue の穴が戻る**
    run(["running", `${process.pid}`]); // **いま生きている PID**
    run(["running", "A"]);
    run(["finished", "A", "0"]);

    expect(run(["--verdict"]).status, "走っている相手を消している").toBe(3);
  });

  it("知らない形は、読めない側へ倒す", () => {
    mkdirSync(statePath(), { recursive: true });
    writeFileSync(join(statePath(), "A"), "なにか\n");

    expect(run(["--verdict"]).status).toBe(2);
  });

  it("使い方の誤りは、通す側に倒さない", () => {
    expect(run([]).status).toBe(2);
    expect(run(["running"]).status, "id が要る").toBe(2);
    expect(run(["finished", "A"]).status).toBe(2);
    expect(run(["finished", "A", "合否"]).status).toBe(2);
    expect(run(["walking"]).status).toBe(2);
  });

  it("記録は作業場ごとに置く", () => {
    // **共通ディレクトリに置くと、別の作業場の check がこちらの可否を決める**
    run(["running", "A"]);

    expect(existsSync(join(statePath(), "A")), "作業場の外に置いている").toBe(true);
    expect(readFileSync(join(statePath(), "A"), "utf8"), "何が起きたかが読めない").toContain(
      "running",
    );
  });
});
