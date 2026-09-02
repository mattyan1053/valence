/**
 * **切られた `./task check` の残りを、落とせるようにする**（#571）。
 *
 * **`./task check:leftovers` は「落としてから打ち直すこと」と言うが、その手が無かった。**
 * **打っても当たらない**——**出る番号はホスト側（`docker top`）で、`AGENTS.md` §2 が
 * 「すべてコンテナ内で実行する」と言うので、打つ側はコンテナの中で落としに行く。**
 * **しかも空振りしても何も言われない。**
 *
 * **口が生えただけでは足りない。** **案内がそれを指していなければ、打つ側は目で
 * PID を拾う**——**それは手順に無い手である**（#571 の完了条件）。
 *
 * **ここで見るのは配線だけ**である。**落とす側の振る舞いは
 * `bin/loop-check-kill.test.ts`、何を落とすかは `bin/loop-check-leftovers.test.ts`
 * が見る**——**判定を 2 箇所に持たない**（`AGENTS.md` §5）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TASK = join(REPO_ROOT, "task");
const LEFTOVERS = join(REPO_ROOT, "bin", "loop-check-leftovers");

const task = () => readFileSync(TASK, "utf8");

describe("残りを落とす口が、配線されている", () => {
  it("`./task check:kill` がある", () => {
    // **`cmd_` で始まる関数が `./task` の口である**（`cmd_help` がそこを拾う）
    expect(task()).toMatch(/^cmd_check_kill\(\)/m);
  });

  it("落とすのはスクリプトで、`task` は番号を数えない", () => {
    // **「何がその走りのぶんか」は `bin/loop-check-leftovers --pids` が持つ**（§5）
    // ——**`task` に `docker top` を書くと、規則が 2 箇所になる**
    expect(task()).toContain("bin/loop-check-kill");
  });

  it("残りを見つけた案内が、その口を名指しする", () => {
    // **名指ししないと、打つ側は目で PID を拾う**——**そこが当たらない**（実測）。
    //
    // **行頭から当てない**（`AGENTS.md` §4）。**この語はスクリプトの説明文にも
    // 出る**ので、**「案内の行」だけを切り出してから見る。**
    const guidance = readFileSync(LEFTOVERS, "utf8")
      .split("\n")
      .filter((line) => /^\s*echo\b/.test(line));

    expect(guidance.join("\n"), "案内が口を名指ししていない").toContain("./task check:kill");
  });
});
