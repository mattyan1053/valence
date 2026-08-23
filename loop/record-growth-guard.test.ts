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

describe("共有の記録のうち、この作業場のぶんだけを見る", () => {
  /** 前後 2 つの記録を置いて、`lease_record_intruders` に判定させる。 */
  function intruders(before: string, after: string, mine: string) {
    const dir = sandbox();
    const beforeFile = join(dir, "before");
    const afterFile = join(dir, "after");
    writeFileSync(beforeFile, before);
    writeFileSync(afterFile, after);
    const done = spawnSync(
      "bash",
      [
        "-c",
        `${shellFunction("lease_record_intruders")}\nlease_record_intruders "${beforeFile}" "${afterFile}" "${mine}"`,
      ],
      { cwd: dir, encoding: "utf8" },
    );
    return { status: done.status ?? -1, stdout: done.stdout.trim() };
  }

  const mine = "/home/loop/valence";
  const line = (at: string, where: string) =>
    `2026-08-23T00:00:${at}Z\tどの役も誰も持っていない\t${where}\n`;

  it("この作業場のぶんが増えていたら、その行を出す", () => {
    const done = intruders(line("01", mine), line("01", mine) + line("02", mine), mine);

    expect(done.status, "増えたのに黙っている").toBe(0);
    expect(done.stdout, "増えた行を出していない").toContain("00:02");
  });

  it("増えていなければ、黙る", () => {
    expect(intruders(line("01", mine), line("01", mine), mine).status).toBe(1);
  });

  it("別の作業場が書いても、黙る", () => {
    // **`./task check` は 5 分走る**——**その間に別の作業場が 1 行書いただけで
    // 赤くなると、合否が他人の持ち物で決まる**（`AGENTS.md` §5 / #186）
    const other = "/home/loop/valence-worker-b";
    const done = intruders(line("01", mine), line("01", mine) + line("02", other), mine);

    expect(done.status, "他人のぶんで赤くしている").toBe(1);
  });

  it("上限に達していても、増えたと分かる", () => {
    // **保つのは 20 件**——**満杯だと、増えても行数は変わらない**
    // （**いちばん効かせたい場面**である）
    const before = Array.from({ length: 20 }, (_, at) =>
      line(String(at).padStart(2, "0"), mine),
    ).join("");
    const after = `${before.split("\n").slice(1).join("\n")}${line("99", mine)}`;

    const done = intruders(before, after, mine);

    expect(done.status, "満杯だと黙っている").toBe(0);
    expect(done.stdout, "増えた行を出していない").toContain("00:99");
  });

  it("記録が読めなければ、黙って通さない", () => {
    const dir = sandbox();
    const done = spawnSync(
      "bash",
      ["-c", `${shellFunction("lease_record_snapshot")}\nlease_record_snapshot`],
      { cwd: dir, encoding: "utf8" },
    );

    // **git はある（無いほうは下の試験）**ので、**記録が無い＝正常**で 0
    expect(done.status).toBe(0);
    expect(done.stdout).toBe("");
  });

  it("git が無ければ、読めたことにしない", () => {
    const dir = sandbox();
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    const done = spawnSync(
      "bash",
      ["-c", `${shellFunction("lease_record_snapshot")}\nlease_record_snapshot`],
      { cwd: dir, encoding: "utf8" },
    );

    expect(done.status, "git が無いのに読めたことにしている").not.toBe(0);
  });
});

describe("`./task check` が、前後を突き合わせている", () => {
  const runner = readFileSync(join(REPO_ROOT, "task"), "utf8");
  const check = runner.slice(runner.indexOf("cmd_check() {")).split("\n}\n")[0] ?? "";

  it("試験の前と後で、記録を取る", () => {
    expect(check, "前を取っていない").toMatch(/lease_record_snapshot >"\$before_file"/);
    expect(check, "後を取っていない").toMatch(/lease_record_snapshot >"\$after_file"/);
  });

  it("この作業場のぶんだけを見る", () => {
    // **他の作業場が書いても、こちらの合否は変わらない**
    expect(check, "作業場を渡していない").toContain(
      'lease_record_intruders "$before_file" "$after_file" "$PWD"',
    );
  });

  it("書かれていたら、落とす", () => {
    // **言うだけにしない**——**`./task check` は「押してよいか」を答える口**である
    const written = check.slice(check.indexOf("lease_record_intruders"));

    expect(written, "落としていない").toMatch(/status=1/);
  });

  it("読めなければ、通さない", () => {
    expect(check, "読めなくても通している").toMatch(/確かめられません/);
  });
});
