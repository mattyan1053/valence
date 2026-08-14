import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * **DB を直列化するロックが、嘘をつかないこと** (#220)。
 *
 * **`flock` が無い環境では `command not found`（127）になる**が、**それを
 * 「別の作業場が使っています」と言っていた**——**誰も掴んでいないのに掴まれていると言う。**
 * **このリポジトリで何度も出ている「判定不能が、別の理由に化ける」**である。
 *
 * **本物の `task` を `source` して関数だけを呼ぶ**（写経しない。写した側だけが古くなる）。
 */
describe("task の DB ロック", () => {
  let box: string;
  let path: string;

  /** `task` の写しと、道具を絞った `PATH` を用意する。 */
  function withTools(options: { flock?: "real" | "missing" | string } = {}): void {
    for (const command of ["bash", "git", "id", "stat", "basename", "dirname", "printf", "sleep"]) {
      const found = spawnSync("which", [command], { encoding: "utf8" }).stdout.trim();
      if (found !== "") {
        spawnSync("ln", ["-sf", found, join(path, command)]);
      }
    }
    rmSync(join(path, "flock"), { force: true });
    if (options.flock === "real") {
      const found = spawnSync("which", ["flock"], { encoding: "utf8" }).stdout.trim();
      expect(found, "この機械に flock が無い").not.toBe("");
      spawnSync("ln", ["-sf", found, join(path, "flock")]);
    } else if (options.flock !== undefined && options.flock !== "missing") {
      // **知らない終わり方を作る**（`flock` の 1 は待ち時間の超過だけである）
      writeFileSync(join(path, "flock"), options.flock, { mode: 0o755 });
    }
  }

  /** `with_db_lock true` を、本物の `task` の関数として走らせる。 */
  function lock(env: Record<string, string> = {}): {
    status: number;
    stdout: string;
    stderr: string;
  } {
    const result = spawnSync(
      join(path, "bash"),
      ["-c", "source ./task >/dev/null 2>&1; with_db_lock true"],
      {
        cwd: box,
        encoding: "utf8",
        env: { ...process.env, PATH: path, ...env },
        timeout: 20_000,
      },
    );
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  beforeEach(() => {
    box = mkdtempSync(join(tmpdir(), "task-db-lock-"));
    path = join(box, "path");
    mkdirSync(path, { recursive: true });
    expect(spawnSync("git", ["init", "--quiet", box]).status).toBe(0);
    writeFileSync(join(box, "task"), readFileSync(join(REPO_ROOT, "task"), "utf8"), {
      mode: 0o755,
    });
    chmodSync(path, 0o755);
    withTools({ flock: "real" });
  });

  afterEach(() => {
    rmSync(box, { recursive: true, force: true });
  });

  it("ロックを取れたら、そのまま実行する", () => {
    expect(lock().status).toBe(0);
  });

  it("flock が無ければ、そう言う", () => {
    // **これが本題。** **`command not found`（127）で `if !` の枝に入り、
    // 「別の作業場が DB を使っています」と出ていた**——**誰も掴んでいないのに、である。**
    withTools({ flock: "missing" });

    const failed = lock();

    expect(failed.status).not.toBe(0);
    // **「flock が 127 で終わりました」では分からない** (#220 の完了条件)。
    // **無いことを、無いと言う**——**終了コードの読み方を人に押し付けない**
    expect(failed.stderr, "flock が無いと分かる形になっていない").toMatch(
      /flock がありません|flock が無い/,
    );
    expect(failed.stderr, "掴まれていると嘘をついている").not.toContain("別の作業場");
  });

  it("待ち時間を超えたら、これまでどおり掴まれていると言う", () => {
    // **倒す先は 2 つある。片方だけ直すと、もう片方が化ける**（#220 の完了条件）
    const held = spawnSync(
      join(path, "bash"),
      [
        "-c",
        `source ./task >/dev/null 2>&1; path="$(db_lock_path)"; ` +
          `flock -x "$path" -c 'sleep 3' & sleep 0.5; wait $!`,
      ],
      { cwd: box, encoding: "utf8", env: { ...process.env, PATH: path }, timeout: 20_000 },
    );
    expect(held.status, held.stderr).toBe(0);

    // 掴んだまま、別のプロセスから待ち時間 0 で取りに行く
    const busy = spawnSync(
      join(path, "bash"),
      [
        "-c",
        `source ./task >/dev/null 2>&1; path="$(db_lock_path)"; ` +
          `flock -x "$path" -c 'sleep 2' & sleep 0.3; ` +
          `DB_LOCK_WAIT_SECONDS=0 with_db_lock true; code=$?; wait; exit $code`,
      ],
      { cwd: box, encoding: "utf8", env: { ...process.env, PATH: path }, timeout: 20_000 },
    );

    expect(busy.status).not.toBe(0);
    expect(busy.stderr, "待ち時間の超過が、別のものに化けている").toContain("別の作業場");
  });

  it("flock が知らない終わり方をしたら、掴まれているとは言わない", () => {
    // **待ち時間の超過は `flock` の 1 だけ**である。**それ以外を同じ枝で扱うと、
    // 判定不能が「掴まれている」に化ける**——**#220 が消しに来た形そのもの**
    withTools({ flock: "#!/usr/bin/env bash\nexit 3\n" });

    const failed = lock();

    expect(failed.status).not.toBe(0);
    expect(failed.stderr, "掴まれていると嘘をついている").not.toContain("別の作業場");
  });

  it("どの環境を通すのかが task に書いてある", () => {
    // **`task:14` は BSD/macOS を避けると書いている**のに、**`flock` に依存していた**
    // ——**決めたことを書く**（#220 の完了条件。通す / 通さないのどちらでもよい）
    const task = readFileSync(join(REPO_ROOT, "task"), "utf8");

    // **「触れている」ではなく「決めた」と読めること。** **`task:14` は既に macOS に
    // 触れている**ので、**言及の有無を見ても、決めたかどうかは分からない**
    const decided = task
      .split("\n")
      .filter((line) => line.includes("macOS"))
      .some((line) => line.includes("対象外") || line.includes("通さない"));

    expect(decided, "macOS を通すかどうかを決めた行が無い").toBe(true);
    expect(task, "flock が要ることが書かれていない").toMatch(/flock[^\n]*(要る|必要|前提)/);
  });
});
