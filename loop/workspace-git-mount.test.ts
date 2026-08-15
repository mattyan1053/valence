/**
 * **worktree の作業場では、コンテナから git が見えなかった**（#80）。
 *
 * **`.git` はファイルで、中身は「本体を指すパス」**である
 * （`gitdir: /…/valence/.git/worktrees/<名前>`）。**コンテナは `${PWD}` しか
 * マウントしていない**ので、**指した先が無い**——**`fatal: not a git repository`。**
 *
 * **`./task check` が赤くなる。** **git を使う試験が 10 件以上ある**（label の一覧、
 * commit hook の実行ビット、停止識別子）。**2 人目の作業場では、何を直しても
 * 緑にできない**——**push の前に緑を求める手順書と噛み合わず、1 本も出せない。**
 *
 * **1 人では出ない。** **`~/valence` は clone そのもの**で、**`.git` は `${PWD}` の
 * 中にある**——**マウントの中に収まっているので、そのまま見える。**
 * **master の worktree も同じ穴を持つ**が、**master は `./task` を通らない**ので
 * 出なかった。**2 人目を実際に走らせて初めて出る。**
 */

import { execFileSync, spawnSync } from "node:child_process";
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

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });
}

/** `./task` と `compose.yaml` を置き、**docker を偽物にした**作業場。 */
function equip(dir: string): string {
  copyFileSync(join(REPO_ROOT, "task"), join(dir, "task"));
  chmodSync(join(dir, "task"), 0o755);
  copyFileSync(join(REPO_ROOT, "compose.yaml"), join(dir, "compose.yaml"));
  const stub = join(dir, "stub");
  mkdirSync(stub);
  const log = join(dir, "docker.log");
  writeFileSync(
    join(stub, "docker"),
    [
      "#!/usr/bin/env bash",
      `printf 'common=%s args=%s\\n' "\${VALENCE_GIT_COMMON_DIR:-未設定}" "$*" >> ${JSON.stringify(log)}`,
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return log;
}

/** clone そのものの作業場（**1 人運用はこちら**）。 */
function clone(): { dir: string; log: string } {
  const parent = mkdtempSync(join(tmpdir(), "workspace-git-mount-"));
  roots.push(parent);
  const dir = join(parent, "valence");
  mkdirSync(dir);
  git(dir, "init", "-q");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return { dir, log: equip(dir) };
}

/** worktree で足した 2 人目の作業場。**`.git` はファイルで、本体は外にある。** */
function worktree(): { dir: string; commonDir: string; log: string } {
  const main = clone().dir;
  const dir = join(main, "..", "valence-worker-x");
  git(main, "worktree", "add", "--detach", dir);
  return { dir, commonDir: join(main, ".git"), log: equip(dir) };
}

/** `common=…` として記録された値（`./task up` が docker へ渡したもの）。 */
function commonIn(log: string): string {
  const found = /common=(\S+) args=compose/.exec(readFileSync(log, "utf8"));
  expect(found, `compose を呼んでいない: ${readFileSync(log, "utf8")}`).not.toBeNull();
  return found?.[1] ?? "";
}

/**
 * `<ホスト>:<コンテナ>` に割る。**`${…}` の中の `:` では割らない**
 * （`${VAR:-既定}` が入るので、素朴に split すると source が途中で切れる）。
 */
function splitMount(entry: string): [string, string] {
  let depth = 0;
  for (let at = 0; at < entry.length; at += 1) {
    const here = entry.slice(at);
    if (here.startsWith("${")) {
      depth += 1;
    } else if (entry[at] === "}" && depth > 0) {
      depth -= 1;
    } else if (entry[at] === ":" && depth === 0) {
      return [entry.slice(0, at), entry.slice(at + 1)];
    }
  }
  return [entry, ""];
}

function up(dir: string): void {
  const result = spawnSync("./task", ["up"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(dir, "stub")}:${process.env.PATH ?? ""}` },
  });
  expect(result.status, result.stderr).toBe(0);
}

describe("worktree の作業場でも、コンテナから git が見える", () => {
  it("git の本体が作業場の外にあるなら、その場所を渡す", () => {
    const { dir, commonDir, log } = worktree();

    up(dir);

    // **`${PWD}` の中には無い。** **渡さなければ、コンテナからは辿れない**
    expect(commonIn(log), "git の本体の場所を渡していない").toBe(commonDir);
  });

  it("clone そのものでも、これまでどおり値が決まる", () => {
    // **1 人運用を壊さない。** **`${PWD}` の中にあるので、マウントは重なるだけ**
    const { dir, log } = clone();

    up(dir);

    expect(commonIn(log), "clone で値が決まっていない").toBe(join(dir, ".git"));
  });

  it("repo の外でも、これまでどおり起動できる", () => {
    // **訊けないのは「repo の中に居ない」ときだけ**である——**worktree なら必ず答えが
    // 返る**ので、**既定へ倒してもこの穴は戻らない。** **止めると、これまで動いていた
    // 使い方（`./task up` は repo を要求しなかった）を黙って壊す**
    const parent = mkdtempSync(join(tmpdir(), "workspace-git-mount-"));
    roots.push(parent);
    const dir = join(parent, "valence");
    mkdirSync(dir);
    const log = equip(dir);

    up(dir);

    expect(commonIn(log), "repo の外で止まっている").toBe(join(dir, ".git"));
  });

  it("compose.yaml が、渡された場所を同じパスへマウントする", () => {
    // **パスを合わせる。** **`.git` の中身は「本体を指す絶対パス」**なので、
    // **コンテナの中でも同じ絶対パスで辿れなければ意味が無い**（`working_dir` と同じ理由）
    const mounts = readFileSync(join(REPO_ROOT, "compose.yaml"), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- ") && line.includes("VALENCE_GIT_COMMON_DIR"))
      .map((line) => splitMount(line.slice(2)));

    expect(mounts, "git の本体をマウントしていない").not.toEqual([]);
    for (const [source, target] of mounts) {
      expect(target, `ホストと違うパスへ置いている: ${source}`).toBe(source);
    }
  });
});
