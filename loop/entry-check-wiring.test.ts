import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/**
 * 入口（`bin/loop-lease acquire`）を飛ばした周回を、**出口より前に**捕まえる（#161）。
 *
 * **記録が増えないことだけを見て緑にしない。** いまも増えていないので、
 * **何もしなくても緑になる**——**飛ばした周回を実際に作って**確かめる。
 *
 * **止めない。** #157 の判断を覆さない——**止めていたら #159 の特定が止まっていた**。
 */
describe("入口を飛ばした周回", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "entry-check-"));
    expect(spawnSync("git", ["init", "--quiet", repo]).status).toBe(0);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function lease(...args: string[]): { status: number; stdout: string; stderr: string } {
    const result = spawnSync(join(REPO_ROOT, "bin/loop-lease"), args, {
      cwd: repo,
      encoding: "utf8",
    });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  function record(): string {
    const path = join(repo, ".git", "valence-loop-lease-missing");
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }

  it("持っていなければ、その場で言う", () => {
    const checked = lease("check", "worker");

    expect(checked.stderr, "飛ばしたことを言っていない").toMatch(/lease/);
    expect(record(), "記録に残っていない").toContain("worker");
  });

  it("止めない", () => {
    // **気づける形は保ったまま、飛ばしにくくする。** 止めると、
    // **その周回でやろうとしていた調査ごと止まる**（#158 で実際にそうなりかけた）
    expect(lease("check", "worker").status).toBe(0);
  });

  it("持っていれば、何も言わない", () => {
    // **cron の周回・人が直接叩く場合に邪魔しない**
    expect(lease("acquire", "worker").status).toBe(0);

    const checked = lease("check", "worker");

    expect(checked.stderr).toBe("");
    expect(record()).toBe("");
  });

  it("記録は増え続けない", () => {
    // **誰が読み、誰が消すのか。** 読むのは `./task loop:status`、
    // **古いものから畳むのはここ**である——**増え続けるだけの記録は、
    // 読む気を失わせるぶん、無いのと同じ**になる
    for (let round = 0; round < 25; round++) {
      lease("check", "worker");
    }

    const lines = record().split("\n").filter(Boolean);

    expect(lines.length, "際限なく積んでいる").toBeLessThanOrEqual(20);
    expect(lines.length, "畳みすぎている").toBeGreaterThan(1);
  });

  it("周回の中で使うスクリプトが、出口より前に確かめる", () => {
    // **出口だけだと、気づくのは終わったあと**——**その周回の直列化は既に効いていない**。
    // **周回で最初に触るもの**が確かめれば、**やり直せるうちに分かる**。
    //
    // **「必ず呼ばれるもの」は 1 つに決められない**（#143 で確かめた——
    // `bin/loop-gate` は open PR が 0 件の周回では呼ばれない）ので、
    // **周回中に触りうるものすべて**に置く。**どれか 1 つでも通れば捕まる**
    for (const script of [
      "bin/loop-claim",
      "bin/loop-gate",
      "bin/loop-review-head",
      "bin/loop-handoff",
    ]) {
      expect(read(script), `${script} が入口を確かめていない`).toMatch(/loop-lease" check|check "/);
    }
  });

  it("判定は 1 箇所に置く", () => {
    // **同じ判定を 2 箇所に持つと、片方だけ直して食い違う**（#159 で踏んだ）
    expect(read("bin/loop-handoff"), "出口が自前で判定している").not.toContain(
      "入口の acquire を飛ばした可能性",
    );
  });
});
