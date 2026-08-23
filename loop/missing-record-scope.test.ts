/**
 * **入口を飛ばした周回の記録が、作業場をまたいで押し出し合う**（#401）。
 *
 * **記録は共通ディレクトリに 1 つで、上限は 20 行**である——**うるさい作業場が
 * 1 つあると、他の作業場の本物が 1 行も残らない。**
 *
 * **当たる先が 2 つある。** **人が `./task loop:status` で読むのは「どの作業場が
 * 入口を飛ばしたか」**であり、**`./task check` の見張り（#398）も、この記録が
 * 増えていないことを測っている**——**別の作業場が 20 行書けば、証拠ごと消える。**
 *
 * **上限そのものは残す**（**際限なく積む記録は、読む気を失わせるぶん、無いのと同じ**）
 * ——**数える単位を作業場ごとにする。**
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const RECORD = "valence-loop-lease-missing";
/** 上限（`bin/loop-lease` の `MISSING_KEEP_DEFAULT`）。**書き写さずに渡す。** */
const KEEP = 5;

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 周回を始められる作業場。**実物のスクリプトを置く**（#227）。 */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "missing-record-"));
  sandboxes.push(dir);
  expect(spawnSync("git", ["init", "--quiet", "-b", "main", dir]).status).toBe(0);
  mkdirSync(join(dir, "bin"), { recursive: true });
  for (const name of ["loop-lease", "loop-procedure-stamp", "loop-stall"]) {
    const target = join(dir, "bin", name);
    copyFileSync(join(REPO_ROOT, "bin", name), target);
    chmodSync(target, 0o755);
  }
  mkdirSync(join(dir, ".claude", "commands"), { recursive: true });
  writeFileSync(join(dir, ".claude", "commands", "loop-worker.md"), "<!-- 版: 0 -->\n手順書\n");
  return dir;
}

const line = (at: number, where: string) =>
  `2026-08-23T00:00:${String(at).padStart(2, "0")}Z\tどの役も誰も持っていない\t${where}`;

function recordOf(dir: string): string[] {
  return readFileSync(join(dir, ".git", RECORD), "utf8")
    .split("\n")
    .filter(Boolean);
}

/** その作業場で `bin/loop-lease check` を打つ（**lease を持っていないので記録される**）。 */
function check(dir: string): void {
  const done = spawnSync(join(dir, "bin", "loop-lease"), ["check"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, LOOP_LEASE_MISSING_KEEP: String(KEEP) },
  });
  expect(done.status, done.stderr).toBe(0);
}

describe("記録の上限は、作業場ごとに数える", () => {
  it("うるさい作業場があっても、他の作業場のぶんが残る", () => {
    // **これが本体**である——**1 つの作業場が上限ぶん書いても、他所の本物は消えない**
    const dir = workspace();
    const noisy = "/home/loop/valence-worker-b";
    const quiet = "/home/loop/valence-worker-c";
    writeFileSync(
      join(dir, ".git", RECORD),
      `${[line(1, quiet), ...Array.from({ length: KEEP * 2 }, (_, at) => line(at + 2, noisy))].join("\n")}\n`,
    );

    check(dir);

    const left = recordOf(dir);
    expect(
      left.filter((row) => row.endsWith(quiet)),
      "静かな作業場のぶんが押し出されている",
    ).toHaveLength(1);
  });

  it("上限は残る（作業場ごとに）", () => {
    // **際限なく積む記録は、読む気を失わせるぶん、無いのと同じ**である
    const dir = workspace();
    const noisy = "/home/loop/valence-worker-b";
    writeFileSync(
      join(dir, ".git", RECORD),
      `${Array.from({ length: KEEP * 3 }, (_, at) => line(at + 1, noisy)).join("\n")}\n`,
    );

    check(dir);

    expect(
      recordOf(dir).filter((row) => row.endsWith(noisy)),
      "上限を超えて積んでいる",
    ).toHaveLength(KEEP);
  });

  it("残るのは新しいほうである", () => {
    const dir = workspace();
    const noisy = "/home/loop/valence-worker-b";
    writeFileSync(
      join(dir, ".git", RECORD),
      `${Array.from({ length: KEEP * 2 }, (_, at) => line(at + 1, noisy)).join("\n")}\n`,
    );

    check(dir);

    const left = recordOf(dir).filter((row) => row.endsWith(noisy));
    expect(left[0], "古いほうを残している").toContain(`:${String(KEEP + 1).padStart(2, "0")}Z`);
  });

  it("自分のぶんも、上限まで積める", () => {
    // **押し出し合いをやめても、自分の記録が 1 行しか残らないのでは読めない**
    const dir = workspace();

    for (let at = 0; at < KEEP + 2; at++) {
      check(dir);
    }

    expect(recordOf(dir).filter((row) => row.endsWith(dir))).toHaveLength(KEEP);
  });

  it("並び順は、時刻のまま", () => {
    // **`./task loop:status` は、そのまま並べて人に見せる**——**混ぜ直さない**
    const dir = workspace();
    const other = "/home/loop/valence-worker-b";
    writeFileSync(
      join(dir, ".git", RECORD),
      `${[line(1, other), line(2, "/home/loop/valence-worker-c"), line(3, other)].join("\n")}\n`,
    );

    check(dir);

    const left = recordOf(dir);
    expect(left.slice(0, 3).map((row) => row.slice(0, 20))).toEqual([
      line(1, other).slice(0, 20),
      line(2, "x").slice(0, 20),
      line(3, other).slice(0, 20),
    ]);
  });
});
