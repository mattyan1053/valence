/**
 * **人が開く画面を、worker の作業場から分ける**（#457）。
 *
 * **`compose.yaml` は `${PWD}` をマウントして `next dev` を回す**ので、**人が開くと
 * worker の作業ツリーがそのまま映る**——**未コミットの実装途中が出る**うえ、
 * **`origin/main` へ追随するのは周回の冒頭だけ**なので、**マージ済みの修正は
 * worker が周回するまで映らない。**
 *
 * **実測（2026-08-24）**: **#453 が 13:49 にログインを直したのに、100 分後に人が
 * 開いても直っていなかった**——**人は「まだ壊れている」と読む。**
 *
 * **見るのは「作れる」ではない。** **`origin/main` を映すこと**、**いつの main かが
 * 分かること**、**worker の一覧に混ざらないこと**である。
 */

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("./task loop:preview", () => {
  let roots: { parent: string; dir: string }[] = [];

  afterEach(() => {
    for (const { parent, dir } of roots) {
      spawnSync("git", ["-C", dir, "worktree", "prune"], { encoding: "utf8" });
      rmSync(parent, { recursive: true, force: true });
    }
    roots = [];
  });

  function git(dir: string, args: string[]): string {
    const ran = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    expect(ran.status, `git ${args.join(" ")}: ${ran.stderr}`).toBe(0);
    return ran.stdout.trim();
  }

  /**
   * 本物の `task` を持つ使い捨てリポジトリ。**`origin` も本物**（bare）にする。
   *
   * **`origin/main` を映すことが主題**なので、**取ってくる先が無いと何も見えない。**
   */
  function repo(): { dir: string; origin: string; env: NodeJS.ProcessEnv } {
    const parent = mkdtempSync(join(tmpdir(), "preview-workspace-"));
    const dir = join(parent, "valence");
    roots.push({ parent, dir });
    mkdirSync(dir);
    expect(spawnSync("git", ["init", "--quiet", "--initial-branch=main", dir]).status).toBe(0);
    copyFileSync(join(REPO_ROOT, "task"), join(dir, "task"));
    chmodSync(join(dir, "task"), 0o755);
    git(dir, ["add", "-A"]);
    git(dir, [
      "-c",
      "user.email=loop@example.invalid",
      "-c",
      "user.name=loop",
      "commit",
      "--quiet",
      "-m",
      "init",
    ]);
    const origin = join(parent, "origin.git");
    expect(
      spawnSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]).status,
    ).toBe(0);
    git(dir, ["remote", "add", "origin", origin]);
    git(dir, ["push", "--quiet", "origin", "main"]);
    git(dir, ["fetch", "--quiet", "origin", "main"]);
    const stub = join(dir, "stub");
    mkdirSync(stub);
    writeFileSync(join(stub, "docker"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    return { dir, origin, env: { ...process.env, PATH: `${stub}:${process.env.PATH ?? ""}` } };
  }

  function task(dir: string, env: NodeJS.ProcessEnv, args: string[]) {
    return spawnSync("./task", args, { cwd: dir, encoding: "utf8", env });
  }

  /**
   * **`origin/main` だけを進める**（作業場は置いていかれる）。
   *
   * **これが #457 の形**である——**worker の作業場は周回の冒頭でしか追随しない**ので、
   * **マージ済みの commit が、作業場より先にある時間**がある。**返すのは新しい commit。**
   */
  function advanceOrigin(dir: string, origin: string, note: string): string {
    const ahead = join(mkdtempSync(join(tmpdir(), "preview-ahead-")), "ahead");
    expect(spawnSync("git", ["clone", "--quiet", origin, ahead]).status).toBe(0);
    writeFileSync(join(ahead, `${note}.txt`), `${note}\n`);
    git(ahead, ["add", "-A"]);
    git(ahead, [
      "-c",
      "user.email=loop@example.invalid",
      "-c",
      "user.name=loop",
      "commit",
      "--quiet",
      "-m",
      note,
    ]);
    git(ahead, ["push", "--quiet", "origin", "main"]);
    // **作業場は移さない。** **`origin/main` の ref だけを取ってくる**（周回の冒頭より前）
    git(dir, ["fetch", "--quiet", "origin", "main"]);
    return git(ahead, ["rev-parse", "HEAD"]);
  }

  it("人が見る作業場ができる", () => {
    const { dir, env } = repo();

    const added = task(dir, env, ["loop:preview:add"]);

    expect(added.status, added.stderr).toBe(0);
    expect(git(dir, ["worktree", "list", "--porcelain"])).toContain(`${dir}-preview`);
  });

  it("worker の作業場の一覧には出さない", () => {
    // **混ぜると、周回を回さないものが「止まっている worker」として数えられる**
    // ——**`bin/loop-cadence` がここを読む**（#378）。**人が呼ばれ続ける。**
    const { dir, env } = repo();
    expect(task(dir, env, ["loop:preview:add"]).status).toBe(0);

    const paths = task(dir, env, ["loop:worker:paths"]);

    expect(paths.status, paths.stderr).toBe(0);
    expect(paths.stdout, "人が見る作業場を worker として数えている").not.toContain(
      `${dir}-preview`,
    );
  });

  it("作業場の HEAD ではなく、origin/main を映す", () => {
    // **これが #457 の芯**である。**「未コミットの変更が映らない」だけでは足りない**
    // ——**別の worktree なら、どこに貼っても未コミットの変更は映らない**（変異で
    // 生き残った）。**判定が効くのは、作業場が `origin/main` より後ろにいるとき**である。
    const { dir, origin, env } = repo();
    const merged = advanceOrigin(dir, origin, "merged");
    // **実装途中を置く。** **`task` そのものは触らない**——**打つのはこの `task` である**
    writeFileSync(join(dir, "wip.txt"), "実装途中\n");

    expect(task(dir, env, ["loop:preview:add"]).status).toBe(0);

    expect(git(`${dir}-preview`, ["rev-parse", "HEAD"]), "作業場の側を映している").toBe(merged);
    expect(git(dir, ["rev-parse", "HEAD"]), "作業場が動いてしまっている").not.toBe(merged);
  });

  it("いつの main を映しているかが分かる", () => {
    // **完了条件**（#457）——**「マージされた」と「画面で使える」を、人が区別できること。**
    const { dir, env } = repo();
    expect(task(dir, env, ["loop:preview:add"]).status).toBe(0);

    const shown = task(dir, env, ["loop:preview:show"]);

    expect(shown.status, shown.stderr).toBe(0);
    expect(shown.stdout, "映している commit が出ていない").toContain(
      git(dir, ["rev-parse", "--short", "origin/main"]),
    );
  });

  it("main が進めば、そこまで追いつく", () => {
    // **周回の冒頭でしか追随しない**のが #457 の症状である——**追いつく口を持つ。**
    const { dir, origin, env } = repo();
    expect(task(dir, env, ["loop:preview:add"]).status).toBe(0);
    const merged = advanceOrigin(dir, origin, "next");

    expect(task(dir, env, ["loop:preview:up"]).status).toBe(0);

    expect(
      git(`${dir}-preview`, ["rev-parse", "HEAD"]),
      "main が進んでも、古いままになっている",
    ).toBe(merged);
  });

  it("人が見る画面と同じポートへ落ちる worker 名は、足す前に弾く", () => {
    // **作られていなくても予約する**（#195 のレビュー 2 周目と同じ形）——**順番を
    // 変えただけで踏める**（`add` を先に、`loop:preview:add` を後に打つ）。
    //
    // **数字を書き写していない。本物に探させた**（`valence-worker-fh` と
    // `valence-preview` は、どちらも同じポートへ落ちる）。
    const { dir, env } = repo();

    const clash = task(dir, env, ["loop:worker:add", "fh"]);

    expect(clash.status, "人が見る画面とポートが重なる名前を通している").not.toBe(0);
    expect(`${clash.stdout}${clash.stderr}`, "何と重なるのかが出ていない").toContain("preview");
  });
});
