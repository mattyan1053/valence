/**
 * **ホストで走るものは、`git` 以外の道具を要求しない**（#383）。
 *
 * **このリポジトリは「ホストには何もインストールしない」と決めている**（`AGENTS.md` §2）
 * ——**`sha256sum` があることを前提にできない。** **いま動いているのは、この VM に
 * たまたま入っているから**である。
 *
 * **#220 が `flock` で同じことを踏んでいる**——**「あると思っていたものが無い」は、
 * 別の機械に置いた日に出る。** **`bin/loop-lease` と `bin/loop-procedure-stamp` は
 * 入口で必ず通る**ので、**無ければ周回が 1 つも始まらない。**
 *
 * **同じ判断を 4 度している**（#195 / #282 / #382 / #383）——**名前で見て、戻らないようにする。**
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN_DIR = join(REPO_ROOT, "bin");

/** ホストで走る bash。**`bin/` の中身と `./task`**（**試験は bash ではない**）。 */
function hostScripts(): string[] {
  const scripts = readdirSync(BIN_DIR)
    .filter((name) => !name.endsWith(".test.ts") && statSync(join(BIN_DIR, name)).isFile())
    .map((name) => join("bin", name));
  return [...scripts, "task"];
}

describe("ホストで走るスクリプトの道具", () => {
  it("`sha256sum` に頼らない", () => {
    // **`git hash-object --stdin` で取る**（`git` は既に必須）——**判定を写さず、同じ手を使う**
    const guilty = hostScripts().filter((path) => {
      const code = readFileSync(join(REPO_ROOT, path), "utf8")
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
      return code.includes("sha256sum");
    });

    expect(guilty, "ホストで走るものが sha256sum に頼っている").toEqual([]);
  });
});
