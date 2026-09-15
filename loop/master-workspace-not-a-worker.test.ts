/**
 * **master の作業場を、worker として並べない**（#738）。
 *
 * **実測（2026-09-15）**: **`bin/loop-cadence` が master の作業場を
 * 「止まっている worker」として 1 行出した。**
 *
 * ```
 * scope=worker-<digest> last_cron=- last_poke=- last_unknown=- age=- window=- never
 *   workspace=<clone>-master
 *   読み=…そのセッションが動いていない——引く先が居ないので、先に起こす
 * ```
 *
 * **実際の値は書かない**（`AGENTS.md` §6。#739 のレビュー）——**このリポジトリは
 * public** で、**絶対パスは個人を指す。** **説明に要るのは「どの作業場か」ではなく
 * 「master の作業場だった」まで**である。
 *
 * **`worker-<digest>` はパスから作った値**なので、**照らすなら自分の環境で取り直す**
 * （`printf '%s' <clone>-master | git hash-object --stdin`）——**写した値を置くと、
 * 読んだ人が合わないものを照らして原因を探しに行く。**
 *
 * **master の作業場に、起こすべき worker は居ない。** **並んだ瞬間に必ず `never`**
 * （**周回を回さないので trigger の記録が無い**）——**人が呼ばれる。**
 *
 * ## 何を見るか
 *
 * **「登録されていれば除ける」だけでは足りない**——**それは前から通っていた。**
 * **穴は、一覧を 2 回引いていたこと**である。**1 回目に master が無く、2 回目に在れば、
 * `skip` が空のまま並ぶ**（**`master_worktree_path` の exit 1 は素通りする**）。
 *
 * **共有の worktree 登録は触らない**（#186。**走っているものと競る**）
 * ——**`git` を差し替えて、1 回目だけ master を落とした一覧を返す。**
 * **これは「2 回の一覧が違いうる」を、そのまま置いた形**である。
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

describe("./task loop:worker:paths", () => {
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

  /** 本物の `task` を持つ使い捨てリポジトリと、その `<clone>-master`。 */
  function repo(): { dir: string; master: string; env: NodeJS.ProcessEnv; stub: string } {
    const parent = mkdtempSync(join(tmpdir(), "master-not-a-worker-"));
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
    const master = `${dir}-master`;
    git(dir, ["worktree", "add", "--detach", "--quiet", master, "HEAD"]);
    const stub = join(dir, "stub");
    mkdirSync(stub);
    return { dir, master, stub, env: { ...process.env } };
  }

  /**
   * **`worktree list` の答えを、呼ばれた順で変える `git`。**
   *
   * **落とすのは `worktree <path>` の 1 行だけ**である——**読む側（`awk` と `grep -qxF`）
   * が見ているのはその行**なので、**「登録されていない」と同じ顔になる。**
   *
   * **向きを 2 つ置く**（**どちらも「2 回の一覧が違う」**）。
   *
   * - `"first"` … **1 回目だけ master が無い**。**あとから引き直した側が並べると出る**
   * - `"after-first"` … **1 回目にだけ master が在る**。**あとから引き直した側が
   *   除外を決めると、`skip` が空になる**
   *
   * **片方だけでは足りない**（**測った**）——**`"first"` だけだと、除外を決める側が
   * 引き直す変異が緑のまま通る。**
   */
  function gitThatHidesMaster(
    dir: string,
    stub: string,
    master: string,
    when: "first" | "after-first" | "never",
  ): NodeJS.ProcessEnv {
    const real = spawnSync("bash", ["-lc", "command -v git"], { encoding: "utf8" }).stdout.trim();
    expect(real, "本物の git が見つからない").not.toBe("");
    const count = join(dir, "worktree-list.count");
    writeFileSync(
      join(stub, "git"),
      [
        "#!/usr/bin/env bash",
        `real=${JSON.stringify(real)}`,
        `count=${JSON.stringify(count)}`,
        `hidden=${JSON.stringify(`worktree ${master}`)}`,
        'if [[ "$1 $2 $3" == "worktree list --porcelain" ]]; then',
        '  n=$(( $(cat "$count" 2>/dev/null || echo 0) + 1 ))',
        '  printf "%s" "$n" >"$count"',
        '  out="$("$real" "$@")" || exit $?',
        `  case ${JSON.stringify(when)} in`,
        "    first) hide=$(( n == 1 )) ;;",
        "    after-first) hide=$(( n != 1 )) ;;",
        "    *) hide=0 ;;",
        "  esac",
        "  if (( hide )); then",
        '    printf "%s\\n" "$out" | grep -vxF "$hidden" || true',
        "  else",
        '    printf "%s\\n" "$out"',
        "  fi",
        "  exit 0",
        "fi",
        'exec "$real" "$@"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    return { ...process.env, PATH: `${stub}:${process.env.PATH ?? ""}` };
  }

  function workerPaths(dir: string, env: NodeJS.ProcessEnv): string[] {
    const ran = spawnSync("./task", ["loop:worker:paths"], { cwd: dir, encoding: "utf8", env });

    expect(ran.status, ran.stderr).toBe(0);
    return ran.stdout.trim().split("\n").filter(Boolean);
  }

  it("登録されている master は、worker として並べない", () => {
    // **当たらない入力の側**（`AGENTS.md` §4）——**これは前から通っていた。**
    const { dir, master, env } = repo();

    const paths = workerPaths(dir, env);

    expect(paths, "master の作業場を worker として数えている").not.toContain(master);
    expect(paths, "自分の作業場が消えている").toContain(dir);
  });

  it("`git worktree list` は 1 回しか引かない", () => {
    // **#738 の完了条件**——**2 回引いているのが意図なのか 1 回でよいのかを決める。**
    // **決めた側を、回数そのもので見る**（**上の 2 つは「違う答えが返ったとき」を
    // 見ている**ので、**引き直しても答えが同じなら通ってしまう**）。
    //
    // **これは「渡されたが空」の経路も塞ぐ** (#739 のレビュー)——**そこで自分から
    // 引き直すと、この数が増える。**
    const { dir, master, stub } = repo();
    const env = gitThatHidesMaster(dir, stub, master, "never");

    workerPaths(dir, env);

    expect(readFileSync(join(dir, "worktree-list.count"), "utf8"), "一覧を引き直している").toBe(
      "1",
    );
  });

  it.each([{ when: "first" }, { when: "after-first" }] as const)(
    "一覧が引くたびに違っても、master は worker として並べない（$when）",
    ({ when }) => {
      // **これが #738 で観測された形**である。**除外を決める一覧と、並べる一覧が
      // 別々に引かれている**と、**その間に変わったぶんだけ除外が外れる。**
      //
      // **向きを両方置く**——**どちらか一方だけだと、引き直す場所を変えた変異が
      // 緑のまま通る**（**`gitThatHidesMaster` の但し書き**）。
      const { dir, master, stub } = repo();
      const env = gitThatHidesMaster(dir, stub, master, when);

      const paths = workerPaths(dir, env);

      expect(paths, "除外を決めた一覧と、並べた一覧が違う").not.toContain(master);
      expect(paths, "自分の作業場が消えている").toContain(dir);
    },
  );
});
