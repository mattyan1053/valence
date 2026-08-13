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
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * **作業場が増えても、互いを壊さないこと**（#82）。
 *
 * **見るのは「2 つ作れる」ではない。** **同時に動いたときに、同じ compose project と
 * 同じポートを掴まないこと**である——**掴めば、後から起きたほうが相手のコンテナを
 * 作り直す**（`compose.yaml` は `name` と port を固定していた）。
 *
 * **「2 人で動いた」と「N 人で衝突しない」は別の主張である**（#99 の教訓）。
 * **ここが主張するのは後者**——**名前が違えば、project もポートも必ず違う。**
 */
describe("作業場ごとに、compose project とポートを分ける", () => {
  let roots: string[] = [];

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
    roots = [];
  });

  /** `task` だけを置いた作業場。**docker は偽物**にして、何を頼んだかだけ記録する。 */
  function workspace(name: string): { dir: string; log: string } {
    const parent = mkdtempSync(join(tmpdir(), "worker-workspaces-"));
    roots.push(parent);
    const dir = join(parent, name);
    mkdirSync(dir);
    copyFileSync(join(REPO_ROOT, "task"), join(dir, "task"));
    chmodSync(join(dir, "task"), 0o755);
    copyFileSync(join(REPO_ROOT, "compose.yaml"), join(dir, "compose.yaml"));
    const stub = join(dir, "stub");
    mkdirSync(stub);
    const log = join(dir, "docker.log");
    writeFileSync(
      join(stub, "docker"),
      `#!/usr/bin/env bash\nprintf 'port=%s args=%s\\n' "\${VALENCE_APP_PORT:-未設定}" "$*" >> ${JSON.stringify(log)}\nexit 0\n`,
      { mode: 0o755 },
    );
    return { dir, log };
  }

  function up(dir: string, stubDir = join(dir, "stub")): void {
    const result = spawnSync("./task", ["up"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ""}` },
    });
    expect(result.status, result.stderr).toBe(0);
  }

  /** 頼んだ project 名（`compose -p <名前>`）。 */
  function projectIn(log: string): string {
    const found = /args=compose -p (\S+)/.exec(readFileSync(log, "utf8"));
    expect(found, `project を指定していない: ${readFileSync(log, "utf8")}`).not.toBeNull();
    return found?.[1] ?? "";
  }

  /** 頼んだポート（`VALENCE_APP_PORT`）。 */
  function portIn(log: string): string {
    const found = /port=(\S+) args=compose -p/.exec(readFileSync(log, "utf8"));
    return found?.[1] ?? "";
  }

  it("名前が違えば、project もポートも違う", () => {
    // **N 人で衝突しないことを見る。** 2 つだけだと「たまたま違った」と区別が付かない
    const names = [
      "valence",
      "valence-worker-a",
      "valence-worker-b",
      "valence-worker-c",
      "valence-master",
    ];
    const seen = names.map((name) => {
      const { dir, log } = workspace(name);
      up(dir);
      return { name, project: projectIn(log), port: portIn(log) };
    });

    expect(new Set(seen.map((one) => one.project)).size, "project が重なっている").toBe(
      names.length,
    );
    expect(new Set(seen.map((one) => one.port)).size, "ポートが重なっている").toBe(names.length);
  });

  it("同じ作業場なら、いつ動かしても同じ値になる", () => {
    // **空きを探して割り当てない**（起動のたびに変わると人が繋ぎ直せない）
    const { dir, log } = workspace("valence-worker-a");

    up(dir);
    up(dir);

    // **compose を呼んだ行だけを見る**（network の用意は毎回同じで、主題ではない）
    const asked = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.includes("args=compose"));

    expect(asked).toHaveLength(2);
    expect(asked[0]).toBe(asked[1]);
  });

  it("既定の 1 人運用は、これまでどおり", () => {
    // **設定を足さなくても壊れない。** `valence` は project も port も動かさない
    const { dir, log } = workspace("valence");

    up(dir);

    expect(projectIn(log)).toBe("valence");
    expect(portIn(log)).toBe("3000");
  });

  it("2 つ同時に動いても、掴む先が重ならない", () => {
    // **本題。** **同じ project を掴むと、後から起きたほうが相手のコンテナを作り直す**
    const first = workspace("valence-worker-a");
    const second = workspace("valence-worker-b");

    const both = spawnSync(
      "bash",
      [
        "-c",
        `cd ${JSON.stringify(first.dir)} && PATH=${JSON.stringify(join(first.dir, "stub"))}:$PATH ./task up & ` +
          `cd ${JSON.stringify(second.dir)} && PATH=${JSON.stringify(join(second.dir, "stub"))}:$PATH ./task up & ` +
          "wait",
      ],
      { encoding: "utf8" },
    );
    expect(both.status, both.stderr).toBe(0);

    expect(projectIn(first.log)).not.toBe(projectIn(second.log));
    expect(portIn(first.log)).not.toBe(portIn(second.log));
  });
});

/**
 * **作業場を増やす／減らす**（#82）。
 *
 * **人数を前提にしない。** 「2 人目」を特別扱いすると 3 人目で作り直しになるので、
 * **名前で増やす**。**名前が識別子**なので、**重複は誤り**である。
 */
describe("./task loop:worker:add / remove", () => {
  let roots: string[] = [];

  afterEach(() => {
    for (const root of roots) {
      // worktree の登録ごと消す（親を消すだけだと prune されない）
      const repo = join(root, "valence");
      spawnSync("git", ["-C", repo, "worktree", "prune"], { encoding: "utf8" });
      rmSync(root, { recursive: true, force: true });
    }
    roots = [];
  });

  /** 本物の `task` を持つ使い捨てリポジトリ。**docker は偽物**にする。 */
  function repo(): { dir: string; log: string; env: NodeJS.ProcessEnv } {
    const parent = mkdtempSync(join(tmpdir(), "worker-add-"));
    roots.push(parent);
    const dir = join(parent, "valence");
    mkdirSync(dir);
    expect(spawnSync("git", ["init", "--quiet", dir]).status).toBe(0);
    copyFileSync(join(REPO_ROOT, "task"), join(dir, "task"));
    chmodSync(join(dir, "task"), 0o755);
    spawnSync("git", ["-C", dir, "add", "-A"]);
    spawnSync("git", [
      "-C",
      dir,
      "-c",
      "user.email=loop@example.invalid",
      "-c",
      "user.name=loop",
      "commit",
      "--quiet",
      "-m",
      "init",
    ]);
    const stub = join(dir, "stub");
    mkdirSync(stub);
    const log = join(dir, "docker.log");
    writeFileSync(
      join(stub, "docker"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`,
      { mode: 0o755 },
    );
    return { dir, log, env: { ...process.env, PATH: `${stub}:${process.env.PATH ?? ""}` } };
  }

  function task(dir: string, env: NodeJS.ProcessEnv, args: string[]) {
    return spawnSync("./task", args, { cwd: dir, encoding: "utf8", env });
  }

  it("名前ごとに作業場ができる", () => {
    const { dir, env } = repo();

    const added = task(dir, env, ["loop:worker:add", "a"]);

    expect(added.status, added.stderr).toBe(0);
    const registered = spawnSync("git", ["-C", dir, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    }).stdout;
    expect(registered).toContain(`${dir}-worker-a`);
  });

  it("同じ名前で 2 度目は失敗する", () => {
    // **名前が識別子**なので、**重複は誤り**である
    const { dir, env } = repo();
    expect(task(dir, env, ["loop:worker:add", "a"]).status).toBe(0);

    const again = task(dir, env, ["loop:worker:add", "a"]);

    expect(again.status, "同じ名前を通している").not.toBe(0);
  });

  it("ポートが既にある作業場と重なる名前は、足す前に失敗する", () => {
    // **N 人で衝突しないことを、確率に任せない。** 名前は決定論的にポートへ写るので、
    // **別の名前が同じポートへ落ちることはある**（`valence-worker-s` と
    // `valence-worker-aa` は、どちらも 3377 になる）。
    //
    // **足したあとに `up` が「アドレス使用中」で落ちる形にしない**——
    // **落ちるのは 2 人目が動き出したときで、原因が名前だと分からない**
    const { dir, env } = repo();
    expect(task(dir, env, ["loop:worker:add", "s"]).status).toBe(0);

    const clash = task(dir, env, ["loop:worker:add", "aa"]);

    expect(clash.status, "同じポートへ落ちる名前を通している").not.toBe(0);
    expect(`${clash.stdout}${clash.stderr}`, "何と衝突したのかが出ていない").toContain("s");
  });

  it("remove で、作業場もコンテナも残らない", () => {
    const { dir, log, env } = repo();
    expect(task(dir, env, ["loop:worker:add", "a"]).status).toBe(0);

    const removed = task(dir, env, ["loop:worker:remove", "a"]);

    expect(removed.status, removed.stderr).toBe(0);
    const registered = spawnSync("git", ["-C", dir, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    }).stdout;
    expect(registered, "worktree が残っている").not.toContain(`${dir}-worker-a`);
    expect(readFileSync(log, "utf8"), "コンテナを落としていない").toContain(
      `compose -p ${basename(dir)}-worker-a down`,
    );
  });

  it("知らない名前を remove しても、黙って成功しない", () => {
    const { dir, env } = repo();

    const missing = task(dir, env, ["loop:worker:remove", "いない"]);

    expect(missing.status, "無い作業場を消したことにしている").not.toBe(0);
  });
});
