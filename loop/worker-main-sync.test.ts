import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
 * **`rebase` の節にも `git fetch origin main` がある**ので、そこを外す。
 */
function syncBlock(): string {
  const body = readFileSync(join(REPO_ROOT, PROCEDURE), "utf8");
  const blocks = [...body.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
  const found = blocks.filter(
    (block) => block.includes("git fetch origin main") && !block.includes("rebase"),
  );
  expect(found, "「main を最新化する」ブロックが 1 つに絞れない").toHaveLength(1);
  return found[0] ?? "";
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
  function workspaces(): { first: string; second: string } {
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
    return { first, second };
  }

  function runSync(cwd: string) {
    return spawnSync("bash", ["-c", syncBlock()], { cwd, encoding: "utf8" });
  }

  it("1 人目が main を掴んでいても、2 人目が通る", () => {
    const { first, second } = workspaces();

    const synced = runSync(second);

    expect(synced.status, synced.stderr).toBe(0);
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

    expect(synced.status, synced.stderr).toBe(0);
  });

  it("落ちたブランチを探すとき、origin/main と比べる", () => {
    // **`main` を掴まなくなるので、ローカルの `main` は進まなくなる**——
    // **`main..<ブランチ>` で比べると、古い基準で数えることになる**
    const body = readFileSync(join(REPO_ROOT, PROCEDURE), "utf8");

    expect(body, "ローカルの main と比べている").not.toMatch(/git log --oneline main\.\./);
  });
});
