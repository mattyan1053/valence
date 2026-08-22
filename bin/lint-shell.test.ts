/**
 * **このリポジトリの bash を lint する**（#377）。
 *
 * **`bin/` は lint の外にあった**——**見ていたのは `task` と `docker-entrypoint.sh` の
 * 2 つだけ**で、**ループの中身（lease・停止カウンタ・ゲート・出口）は 1 つも
 * 入っていなかった。** **実測**: PR #376 で `task` を触ったから SC1010 を拾えた
 * ——**同じものを `bin/` に書いていたら、CI も気づかない。**
 */

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./lint-shell", import.meta.url));
const BIN_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function run(
  args: string[],
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(SCRIPT, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe("bin/lint-shell", () => {
  /** 対象の basename。**パスの書き方には依存しない。** */
  function listed(): string[] {
    return run(["--list"])
      .stdout.split("\n")
      .filter(Boolean)
      .map((path) => basename(path));
  }

  it("bin/ の bash を、1 つ残らず対象にする", () => {
    // **一覧を書き写さない**——**次に足したスクリプトが黙って外れる**（§5）。
    // **除くのは試験だけ**（**あれは bash ではない**）
    const scripts = readdirSync(BIN_DIR).filter(
      (name) => !name.endsWith(".test.ts") && statSync(join(BIN_DIR, name)).isFile(),
    );

    expect(listed()).toEqual(expect.arrayContaining(scripts));
  });

  it("入口の 2 つも、これまでどおり見る", () => {
    expect(listed()).toEqual(expect.arrayContaining(["task", "docker-entrypoint.sh"]));
  });

  it("試験は対象にしない", () => {
    expect(listed().filter((name) => name.endsWith(".test.ts"))).toEqual([]);
  });

  it("shellcheck が無ければ、緑にしない", () => {
    // **skip は緑に見える**（#210）——**見ていないことを「指摘なし」と答えない。**
    //
    // **呼ぶものを差し替えて見る**——**この試験はコンテナの中で走り**（shellcheck は
    // 入っていない）、**手元やホストでは入っていることがある**。**どちらでも同じ形で
    // 確かめられるようにする。**
    const result = run([], { LOOP_SHELLCHECK: "shellcheck-does-not-exist" });

    expect(result.status, "無いのに通している").toBe(2);
    expect(result.stderr, "何が無いのか読めない").toContain("shellcheck");
  });

  // **「いま指摘が 0 件であること」は CI が見る**（`.github/workflows/audit.yml`）。
  // **ここでは見ない**——**この試験はコンテナの中で走り、shellcheck が入っていない。**
  // **入れる判断は別の PR**（イメージを作り直す必要があり、走っている作業場が赤くなる）。

  it("使い方の誤りは、緑にしない", () => {
    expect(run(["--everything"]).status).toBe(2);
  });
});
