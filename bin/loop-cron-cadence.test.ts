import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * **予定表の刻みを、生きているうちに残す** (#677。**#679 のレビュー 2 周目**)。
 *
 * **通知で起こされた周回は、cron に運ばれていない**——**「この周回を運んできた刻み」が
 * 無い。** **予定表が切れたあとに起こされた周回こそ入れ直したい**のに、
 * **入れ直す先を決められない。**
 *
 * **生きている間なら `CronList` が答える**ので、**そのときに残しておく。**
 */
const SCRIPT = fileURLToPath(new URL("./loop-cron-cadence", import.meta.url));

describe("bin/loop-cron-cadence", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "loop-cron-cadence-"));
    expect(spawnSync("git", ["init", "--quiet", sandbox]).status).toBe(0);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  function run(args: readonly string[], now = 1789052740) {
    return spawnSync(SCRIPT, args, {
      cwd: sandbox,
      encoding: "utf8",
      env: { ...process.env, LOOP_CRON_CADENCE_NOW: String(now) },
    });
  }

  it("残した刻みを、次の周回が読める", () => {
    expect(run(["worker", "30m"]).status).toBe(0);

    const read = run(["worker"]);

    expect(read.status).toBe(0);
    expect(read.stdout.trim()).toBe("30m");
  });

  it("役ごとに分けて持つ", () => {
    // **作業場ごとに刻みが違う**（#677）——**畳むと、片方の刻みで両方を入れ直す**
    run(["worker", "30m"]);
    run(["master", "10m"]);

    expect(run(["worker"]).stdout.trim()).toBe("30m");
    expect(run(["master"]).stdout.trim()).toBe("10m");
  });

  it("いつ残したかも残る", () => {
    // **古い刻みで入れ直したかどうかを、あとから追える**
    run(["worker", "30m"]);

    const shown = run(["worker", "--verbose"]);

    expect(shown.stdout).toContain("1789052740");
  });

  it("残っていなければ、そう言う（勝手に決めない）", () => {
    // **判定不能を「無い」へ倒さない**——**入れ直す側は、これで足さないと決められる**
    const read = run(["worker"]);

    expect(read.status).toBe(1);
    expect(read.stdout.trim()).toBe("");
  });

  it("上書きすると、新しいほうが残る", () => {
    run(["worker", "30m"]);
    run(["worker", "45m"], 1789052800);

    expect(run(["worker"]).stdout.trim()).toBe("45m");
  });

  it("刻みの形が違えば、残さない", () => {
    for (const every of ["30", "m", "0m", "30x", "-5m"]) {
      expect(run(["worker", every]).status, every).toBe(2);
      expect(run(["worker"]).status, every).toBe(1);
    }
  });

  it("役の名前が違えば、受け取らない", () => {
    // **綴り違いで別のファイルに残ると、読む側は「残っていない」と読む**
    for (const role of ["", "workers", "Worker", "../worker"]) {
      expect(run([role, "30m"]).status, role).toBe(2);
    }
  });

  it("壊れた行は、読まずに「残っていない」と言う", () => {
    // **形の違う行を刻みとして返すと、その形で入れ直しに行く**
    writeFileSync(join(sandbox, ".git", "valence-loop-cron-cadence-worker"), "こわれています\n");

    expect(run(["worker"]).status).toBe(2);
  });

  it("git の中でなければ、判定できないと言う", () => {
    const outside = mkdtempSync(join(tmpdir(), "loop-cron-cadence-bare-"));
    try {
      expect(spawnSync(SCRIPT, ["worker", "30m"], { cwd: outside, encoding: "utf8" }).status).toBe(
        2,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("作業場ごとに持つ（共通ディレクトリへ置かない）", () => {
    // **同じリポジトリの別の作業場が、別の刻みで回っている**——**共通の場所へ置くと、
    // 最後に書いた作業場の刻みで、全部が入れ直る。**
    // **リンクされた作業ツリーを実際に作って測る**——**素の clone では、
    // 作業場の git ディレクトリと共通ディレクトリが同じ場所になる**ので、
    // **置き場所を間違えても緑になる**
    writeFileSync(join(sandbox, "seed"), "seed\n");
    expect(spawnSync("git", ["add", "-A"], { cwd: sandbox }).status).toBe(0);
    expect(
      spawnSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-m", "seed"], {
        cwd: sandbox,
      }).status,
    ).toBe(0);
    const linked = join(sandbox, "..", `${sandbox.split("/").pop()}-linked`);
    expect(spawnSync("git", ["worktree", "add", linked], { cwd: sandbox }).status).toBe(0);

    try {
      expect(
        spawnSync(SCRIPT, ["worker", "45m"], {
          cwd: linked,
          encoding: "utf8",
          env: { ...process.env, LOOP_CRON_CADENCE_NOW: "1789052740" },
        }).status,
      ).toBe(0);

      // **共通ディレクトリには出ていない**——**そちらは別の作業場も読む**
      expect(
        existsSync(join(sandbox, ".git", "valence-loop-cron-cadence-worker")),
        "共通ディレクトリに置いている",
      ).toBe(false);
      // **こちらの作業場からは、これまでどおり「残っていない」と読める**
      expect(run(["worker"]).status).toBe(1);
    } finally {
      spawnSync("git", ["worktree", "remove", "--force", linked], { cwd: sandbox });
      rmSync(linked, { recursive: true, force: true });
    }
  });
});
