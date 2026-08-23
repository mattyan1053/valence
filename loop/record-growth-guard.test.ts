/**
 * **試験が共有の記録を汚さないことを、記録そのもので見る**（#397）。
 *
 * **別名を追う見張りは、追う形を 1 つずつ足す限り終わらない**（#390 / #393 / #394 で
 * 3 度足した。定数経由 / 括弧の中のカンマ / `cwd: REPO_ROOT` の先読み / 既定引数）
 * ——**JavaScript の別名は正規表現で数え切れない。**
 *
 * **記録そのものを測れば、別名は関係ない。** **増えたのがどの試験かは分からなくてよい**
 * ——**増えたことが分かれば、探せる。**
 *
 * **測る場所は `./task check` である。** **vitest の `globalSetup` の teardown で
 * 投げても、実行は緑のまま終わる**（**実測: `error during close` は出るが `exit=0`**）
 * ——**落とせない場所に見張りを置かない。**
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const RECORD = "valence-loop-lease-missing";

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** `./task` の関数を、そのまま取り出して走らせる。**書き写さない。** */
function shellFunction(name: string): string {
  const runner = readFileSync(join(REPO_ROOT, "task"), "utf8");
  const from = runner.indexOf(`${name}() {`);
  expect(from, `${name} が ./task にありません`).toBeGreaterThanOrEqual(0);
  return `${runner.slice(from).split("\n}\n")[0] ?? ""}\n}\n`;
}

/** git のある使い捨ての作業場。 */
function sandbox(lines?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "record-growth-"));
  sandboxes.push(dir);
  expect(spawnSync("git", ["init", "--quiet", "-b", "main", dir]).status).toBe(0);
  if (lines !== undefined) {
    writeFileSync(join(dir, ".git", RECORD), lines);
  }
  return dir;
}

function countIn(dir: string): { status: number; stdout: string } {
  const done = spawnSync(
    "bash",
    ["-c", `${shellFunction("lease_record_lines")}\nlease_record_lines`],
    {
      cwd: dir,
      encoding: "utf8",
    },
  );
  return { status: done.status ?? -1, stdout: done.stdout.trim() };
}

describe("記録の増減を、`./task check` が見る", () => {
  it("記録が無ければ 0 と数える", () => {
    // **1 度も飛ばしていないのは正常な状態**である——**そこで落とさない**
    expect(countIn(sandbox())).toEqual({ status: 0, stdout: "0" });
  });

  it("行を数える", () => {
    expect(countIn(sandbox("1 行目\n2 行目\n"))).toEqual({ status: 0, stdout: "2" });
  });

  it("読めなければ、0 と言わない", () => {
    // **「読めなかった」を「増えていない」にしない**——**黙って通ると、この見張りが
    // 何も見ていない状態で緑になる**
    const dir = sandbox();
    rmSync(join(dir, ".git"), { recursive: true, force: true });

    expect(countIn(dir).status, "git が無いのに数えている").not.toBe(0);
  });

  it("記録がファイルでなければ、0 と言わない", () => {
    const dir = sandbox();
    spawnSync("mkdir", ["-p", join(dir, ".git", RECORD)]);

    expect(countIn(dir).status, "ディレクトリを数えている").not.toBe(0);
  });
});

describe("`./task check` が、前後を突き合わせている", () => {
  const runner = readFileSync(join(REPO_ROOT, "task"), "utf8");
  const check = runner.slice(runner.indexOf("cmd_check() {")).split("\n}\n")[0] ?? "";

  it("試験の前と後で数える", () => {
    // **前だけ・後だけでは、増えたかどうかは出ない**
    expect(check, "前を数えていない").toMatch(/record_before=.*lease_record_lines/s);
    expect(check, "後を数えていない").toMatch(/record_after=.*lease_record_lines/s);
  });

  it("動いていたら、落とす", () => {
    // **言うだけにしない**——**`./task check` は「押してよいか」を答える口**である
    const moved = check.slice(check.indexOf("record_before != "));

    expect(moved, "落としていない").toMatch(/status=1/);
  });

  it("読めなければ、通さない", () => {
    expect(check, "読めなくても通している").toMatch(/汚していないことを確かめられません/);
  });
});
