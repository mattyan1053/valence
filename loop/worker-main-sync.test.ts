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
const PROCEDURE = ".claude/commands/loop-worker.md";

/**
 * 手順書の「`main` を最新化する」ブロックを取り出す。**書き写さない**——
 * **写すと、手順書を直さなくても緑のまま通る**（#181 / #183 と同じ理由）。
 *
 * **判断は `bin/loop-sync-main` が持つ** (#217)。**手順書が指しているものを、
 * 手順書に書いてあるとおりに走らせる。**
 */
function syncBlock(): string {
  const body = readFileSync(join(REPO_ROOT, PROCEDURE), "utf8");
  const blocks = [...body.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
  // **rebase の前にも同じ口を通る**（`--fetch-only`）ので、そちらを外す。
  // **1.0 の「枝から戻る」も同じ口を通る** (#369)——**あちらは戻すだけで、
  // 入れ替わったかは見ない**ので、**`bin/loop-procedure-changed` の有無で分ける。**
  const found = blocks.filter(
    (block) =>
      block.includes("bin/loop-sync-main") &&
      !block.includes("--fetch-only") &&
      block.includes("bin/loop-procedure-changed"),
  );
  expect(found, "「main を最新化する」ブロックが 1 つに絞れない").toHaveLength(1);
  return found[0] ?? "";
}

/**
 * 作業場から、手順書のとおり `bin/loop-sync-main` を呼べるようにする。
 *
 * **手順書は作業場の相対パスで書いてある**ので、**そこに実物が要る**
 * ——**写しではなく、リポジトリの実物をそのまま置く。**
 */
function placeSyncScript(workspace: string): void {
  const bin = join(workspace, "bin");
  mkdirSync(bin, { recursive: true });
  // **このブロックが呼ぶものを、すべて実物で置く** (#227)。**偽物にすると、
  // 「呼んでいるのに何も見ていない」形が緑になる。**
  for (const name of ["loop-sync-main", "loop-procedure-changed", "loop-stall"]) {
    const target = join(bin, name);
    copyFileSync(join(REPO_ROOT, "bin", name), target);
    chmodSync(target, 0o755);
  }
}

/**
 * 同期のブロックの終了コード。
 *
 * **最後に走るのは `bin/loop-procedure-changed`** なので、**0（入れ替わった）と
 * 1（変わっていない）のどちらも「同期そのものは通った」**である
 * ——**落ちた場合（2 以上）と分ける。**
 */
function syncRan(status: number | null, stderr: string): void {
  expect([0, 1], `同期のブロックが落ちている: ${stderr}`).toContain(status);
}

/**
 * **2 人目の worker が、手順書の 1 歩目を通れること**（#196）。
 *
 * **`main` は 1 つの worktree にしか checkout できない。** **1 人目が掴んでいる**ので、
 * **2 人目の `git switch main` は `fatal` で落ちる**——**手順書はそこで
 * `bin/loop-stall main-sync-failed` を通して止まれと書いてある**ので、
 * **2 人目は毎周回止まり、3 周で `loop/STOP` を配る。1 人目まで巻き添えで止まる。**
 *
 * **変異が通る入力を先に決める**（#195 の教訓）——**1 人目が `main` を掴んでいる状態**を
 * 作らないと、**この経路には入らない**。
 */
describe("worker の main 最新化", () => {
  let roots: string[] = [];

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
    roots = [];
  });

  /** `origin/main` を持つ使い捨てのリポジトリと、その 2 人目の作業場。 */
  function workspaces(): { first: string; second: string; origin: string } {
    const parent = mkdtempSync(join(tmpdir(), "worker-main-sync-"));
    roots.push(parent);
    const origin = join(parent, "origin.git");
    const first = join(parent, "valence");
    expect(spawnSync("git", ["init", "--bare", "--quiet", "-b", "main", origin]).status).toBe(0);
    expect(spawnSync("git", ["clone", "--quiet", origin, first]).status).toBe(0);
    const git = (args: string[], cwd = first) =>
      spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env } });
    expect(
      git([
        "-c",
        "user.email=loop@example.invalid",
        "-c",
        "user.name=loop",
        "commit",
        "--allow-empty",
        "--quiet",
        "-m",
        "init",
      ]).status,
    ).toBe(0);
    expect(git(["push", "--quiet", "origin", "main"]).status).toBe(0);
    // **1 人目が `main` を掴んでいる**——これが、この経路へ入るための入力である
    expect(git(["symbolic-ref", "--short", "HEAD"]).stdout.trim()).toBe("main");
    // **2 人目は古い commit から始める。** **同じ位置から始めると、
    // 「fetch しただけで先端へ移らない」形も緑になる**（実際に変異が通った）
    const second = `${first}-worker-a`;
    expect(git(["worktree", "add", "--detach", "--quiet", second, "HEAD"]).status).toBe(0);
    expect(
      git([
        "-c",
        "user.email=loop@example.invalid",
        "-c",
        "user.name=loop",
        "commit",
        "--allow-empty",
        "--quiet",
        "-m",
        "次の commit",
      ]).status,
    ).toBe(0);
    expect(git(["push", "--quiet", "origin", "main"]).status).toBe(0);
    placeSyncScript(first);
    placeSyncScript(second);
    return { first, second, origin };
  }

  function runSync(cwd: string) {
    return spawnSync("bash", ["-c", syncBlock()], { cwd, encoding: "utf8" });
  }

  it("1 人目が main を掴んでいても、2 人目が通る", () => {
    const { first, second } = workspaces();

    const synced = runSync(second);

    syncRan(synced.status, synced.stderr);
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: second, encoding: "utf8" }).stdout;
    const upstream = spawnSync("git", ["rev-parse", "origin/main"], {
      cwd: first,
      encoding: "utf8",
    }).stdout;
    expect(head.trim(), "origin/main の先端にいない").toBe(upstream.trim());
  });

  it("1 人目も、同じ手順で通る", () => {
    // **手順を 2 つに分けない。** **作業場ごとに違う手順**にすると、
    // **どちらが正なのかが読む人に分からなくなる**
    const { first } = workspaces();

    const synced = runSync(first);

    syncRan(synced.status, synced.stderr);
  });

  it("もう一方の作業場に fetch を競り負けても、通る", () => {
    // **`refs/remotes/origin/main` は `--git-common-dir` にある**ので、
    // **worktree を分けても共有**である。**2 人が同じ周回の冒頭で fetch すると、
    // 後から書く側が `cannot lock ref` で落ちる**（master の実測で 25/25）。
    //
    // **そのとき ref は既に目的の値**である——**「壊れているのに緑」の逆で、
    // 直っているのに赤**になり、`main-sync-failed` を記録して止まる。
    // **両方の worker が周回の冒頭で同期する**ので、**マージ直後の周回は必ずここで揃う。**
    //
    // **競りそのものは試験にしない**（時間に依存する）。**負けた側の入力**——
    // **1 度目の fetch が `cannot lock ref` で落ちる**——を作って、そこから先を見る。
    //
    // **上流だけを進めておく**（別の clone から push する）。**共有 ref が既に
    // 目的の値だと、「失敗を握りつぶして進む」形も緑になる**——**2 度目の fetch が
    // 要る状態でなければ、やり直しを押さえられない。**
    const { first, second, origin } = workspaces();
    const pusher = `${first}-pusher`;
    expect(spawnSync("git", ["clone", "--quiet", origin, pusher]).status).toBe(0);
    expect(
      spawnSync(
        "git",
        [
          "-c",
          "user.email=loop@example.invalid",
          "-c",
          "user.name=loop",
          "commit",
          "--allow-empty",
          "--quiet",
          "-m",
          "もう一方が進めた",
        ],
        { cwd: pusher },
      ).status,
    ).toBe(0);
    expect(spawnSync("git", ["push", "--quiet", "origin", "main"], { cwd: pusher }).status).toBe(0);

    const real = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    const stubs = join(second, "stub");
    mkdirSync(stubs);
    writeFileSync(
      join(stubs, "git"),
      [
        "#!/usr/bin/env bash",
        'if [[ $1 == "fetch" ]]; then',
        `  count="$(cat ${JSON.stringify(join(second, "fetch.count"))} 2>/dev/null || echo 0)"`,
        `  printf '%s' "$((count + 1))" > ${JSON.stringify(join(second, "fetch.count"))}`,
        "  if ((count == 0)); then",
        "    echo \"error: cannot lock ref 'refs/remotes/origin/main'\" >&2",
        "    exit 1",
        "  fi",
        "fi",
        `exec ${JSON.stringify(real)} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const synced = spawnSync("bash", ["-c", syncBlock()], {
      cwd: second,
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubs}:${process.env.PATH ?? ""}` },
    });

    syncRan(synced.status, synced.stderr);
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: second, encoding: "utf8" }).stdout;
    // **上流そのものと比べる。** 共有 ref と比べると、**更新できていなくても一致する**
    const upstream = spawnSync("git", ["--git-dir", origin, "rev-parse", "main"], {
      encoding: "utf8",
    }).stdout;
    expect(head.trim(), "上流の先端にいない").toBe(upstream.trim());
  });

  it("落ちたブランチを探すとき、origin/main と比べる", () => {
    // **`main` を掴まなくなるので、ローカルの `main` は進まなくなる**——
    // **`main..<ブランチ>` で比べると、古い基準で数えることになる**
    const body = readFileSync(join(REPO_ROOT, PROCEDURE), "utf8");

    expect(body, "ローカルの main と比べている").not.toMatch(/git log --oneline main\.\./);
  });
});
