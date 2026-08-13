import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROCEDURE = ".claude/commands/loop-worker.md";

/**
 * 手順書の bash ブロックを全部取り出す。**書き写さない**（#181 / #183）——
 * **写すと、手順書を直さなくても緑のまま通る**。
 */
function bashBlocks(): string[] {
  const body = readFileSync(join(REPO_ROOT, PROCEDURE), "utf8");
  return [...body.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
}

/** 手順書の行のうち、コマンドとして書かれているもの（コメント行を除く）。 */
function commandLines(): string[] {
  return bashBlocks()
    .flatMap((block) => block.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** **落ちた周回のブランチへ入る**ブロック（ステップ 2.2）。 */
function resumeBlock(): string {
  const found = bashBlocks().filter(
    (block) => block.includes("git switch") && block.includes("<ブランチ>"),
  );
  expect(found, "落ちた周回のブランチへ入るブロックが 1 つに絞れない").toHaveLength(1);
  return found[0] ?? "";
}

/**
 * **`git switch` が exit 128 で落ちる経路が、手順書に残っていないこと** (#102)。
 *
 * **ブランチは 1 つの作業場にしか checkout できない。** **落ちた作業場が掴んだまま**なので、
 * **引き継ぐ側の `git switch <ブランチ>` は `fatal: 'x' is already used by worktree at …`**
 * で落ちる——**`bin/loop-claim` が所有権を移しても、続きが実行できない。**
 *
 * **#197 と同じ向きへ倒す。** **worker はブランチを掴まない**——**detached で入り、
 * push でだけブランチ名を使う**。**掴まなければ、奪う相手もいない。**
 */
describe("落ちた作業場のブランチを引き継ぐ", () => {
  let roots: string[] = [];

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
    roots = [];
  });

  const BRANCH = "fix/落ちた周回";

  function git(args: string[], cwd: string) {
    return spawnSync(
      "git",
      ["-c", "user.email=loop@example.invalid", "-c", "user.name=loop", ...args],
      {
        cwd,
        encoding: "utf8",
      },
    );
  }

  /**
   * **1 人目がブランチを掴んだまま落ちた**状態と、その 2 人目の作業場。
   *
   * **入力は 2 つ要る**（#195 / #196 / #197 / #200 で繰り返し踏んだ形）——
   * **1 人目が掴んでいないと、`git switch <ブランチ>` は成功してしまう。**
   */
  function workspaces(): { dead: string; taker: string; origin: string; tip: string } {
    const parent = mkdtempSync(join(tmpdir(), "worker-branch-handoff-"));
    roots.push(parent);
    const origin = join(parent, "origin.git");
    const dead = join(parent, "valence");
    expect(spawnSync("git", ["init", "--bare", "--quiet", "-b", "main", origin]).status).toBe(0);
    expect(spawnSync("git", ["clone", "--quiet", origin, dead]).status).toBe(0);
    expect(git(["commit", "--allow-empty", "--quiet", "-m", "init"], dead).status).toBe(0);
    expect(git(["push", "--quiet", "origin", "main"], dead).status).toBe(0);
    // **1 人目が、この Issue のブランチを掴んだまま落ちている**
    expect(git(["switch", "--quiet", "-c", BRANCH], dead).status).toBe(0);
    expect(git(["commit", "--allow-empty", "--quiet", "-m", "作りかけ"], dead).status).toBe(0);
    const tip = git(["rev-parse", "HEAD"], dead).stdout.trim();
    const taker = `${dead}-worker-a`;
    expect(git(["worktree", "add", "--detach", "--quiet", taker, "origin/main"], dead).status).toBe(
      0,
    );
    // **2 人目は `origin/main` にいる**（手順書のステップ 1 が置く位置）——
    // **同じ位置から始めると、「入ったつもりで動いていない」形も緑になる**
    expect(git(["rev-parse", "HEAD"], taker).stdout.trim()).not.toBe(tip);
    return { dead, taker, origin, tip };
  }

  function runResume(cwd: string) {
    return spawnSync("bash", ["-c", resumeBlock().replaceAll("<ブランチ>", BRANCH)], {
      cwd,
      encoding: "utf8",
    });
  }

  it("1 人目が掴んだままでも、2 人目がそのブランチへ入れる", () => {
    const { taker, tip } = workspaces();

    const resumed = runResume(taker);

    expect(resumed.status, resumed.stderr).toBe(0);
    // **「落ちなかった」だけでは足りない**（倒す先は 2 つある。#200 で 3 回出た）——
    // **`origin/main` に居座ったまま成功しても、引き継げてはいない。**
    // **作りかけの commit の上にいること**まで見る
    expect(
      git(["rev-parse", "HEAD"], taker).stdout.trim(),
      "落ちた周回の作りかけの上にいない",
    ).toBe(tip);
  });

  it("1 人目も、同じ手順でそのブランチへ入れる", () => {
    // **手順を 2 つに分けない**（#196 と同じ理由）——**作業場ごとに違う手順にすると、
    // どちらが正なのかが読む人に分からなくなる**
    const { dead, tip } = workspaces();

    const resumed = runResume(dead);

    expect(resumed.status, resumed.stderr).toBe(0);
    expect(git(["rev-parse", "HEAD"], dead).stdout.trim()).toBe(tip);
  });

  it("引き継いだ側が、そのまま push できる", () => {
    // **ブランチを掴まないので、`git push` は追跡先を持たない**——
    // **`git push` だけでは `HEAD` が「full refname ではない」で落ちる**（実測）。
    // **手順書の push が、掴まない形と噛み合っていること**を見る
    const { taker, origin, tip } = workspaces();
    expect(runResume(taker).status).toBe(0);
    expect(git(["commit", "--allow-empty", "--quiet", "-m", "続きを実装した"], taker).status).toBe(
      0,
    );

    const pushes = commandLines().filter((line) => line.startsWith("git push"));
    expect(pushes.length, "手順書に push が無い").toBeGreaterThan(0);
    for (const push of pushes) {
      const pushed = spawnSync("bash", ["-c", push.replaceAll("<ブランチ>", BRANCH)], {
        cwd: taker,
        encoding: "utf8",
      });
      expect(pushed.status, `${push}\n${pushed.stderr}`).toBe(0);
    }

    const remote = spawnSync("git", ["--git-dir", origin, "rev-parse", BRANCH], {
      encoding: "utf8",
    }).stdout.trim();
    expect(remote, "push しても、続きが上流に載っていない").not.toBe(tip);
    expect(remote).toBe(git(["rev-parse", "HEAD"], taker).stdout.trim());
  });

  /** 「PR を作る」のうち、ブランチ名を先へ進める行。 */
  function updateBranch(cwd: string, branch: string) {
    const block = bashBlocks().filter((one) => one.includes("git branch -f"));
    expect(block, "落ちた周回の commit を拾う手立てが無い").toHaveLength(1);
    const line = (block[0] ?? "")
      .split("\n")
      .filter((one) => one.trim().length > 0 && !one.trim().startsWith("#"))
      .join("\n")
      .match(/git branch -f[\s\S]*?\n(?=git push)/)?.[0];
    expect(line, "ブランチ名を進める行を取り出せない").toBeDefined();
    return spawnSync("bash", ["-c", (line ?? "").replaceAll("<ブランチ>", branch)], {
      cwd,
      encoding: "utf8",
    });
  }

  it("落ちても拾えるように、ブランチ名は先へ進めておく", () => {
    // **消す側を足したら、残る側の前提を見直す**（`AGENTS.md` §5）——**掴まなくなると、
    // push と `gh pr create` の間で落ちた commit が、どこからも辿れなくなる。**
    // **ステップ 2.2 の「コミットが載ったブランチ」が拾えなくなる。**
    const { taker } = workspaces();
    expect(git(["commit", "--allow-empty", "--quiet", "-m", "新しい仕事"], taker).status).toBe(0);

    const updated = updateBranch(taker, "feat/新しい仕事");

    expect(updated.status, updated.stderr).toBe(0);
    expect(
      git(["rev-parse", "feat/新しい仕事"], taker).stdout.trim(),
      "ブランチが、この周回の commit まで進んでいない",
    ).toBe(git(["rev-parse", "HEAD"], taker).stdout.trim());
  });

  it("進められなくても、引き継ぎは止まらない", () => {
    // **`git branch -f` は、掴まれているブランチには exit 128 で落ちる**（実測）——
    // **引き継ぎを直したこの変更自身が、引き継ぎを止める**形になる。
    //
    // **`git update-ref` なら通るが、掴んでいる作業場の HEAD を黙って動かす**ので採らない
    // （**共有された状態は、読むだけでも依存が残る**。`AGENTS.md` §5）。
    // **落ちた作業場が掴んでいるとき、そのブランチの先端はいまの HEAD そのもの**なので、
    // **進められなくても失うものが無い。**
    const { dead, taker, origin, tip } = workspaces();

    expect(runResume(taker).status).toBe(0);
    const updated = updateBranch(taker, BRANCH);

    expect(updated.status, `${updated.stdout}${updated.stderr}`).toBe(0);
    expect(updated.stdout, "進められなかったことが、どこにも出ていない").toContain("[INFO]");
    // **掴んでいる側の足元を動かしていない**（`git update-ref` との違い）
    expect(git(["rev-parse", "HEAD"], dead).stdout.trim(), "掴んでいる作業場の HEAD が動いた").toBe(
      tip,
    );
    const pushes = commandLines().filter((line) => line.startsWith("git push origin"));
    const pushed = spawnSync("bash", ["-c", (pushes[0] ?? "").replaceAll("<ブランチ>", BRANCH)], {
      cwd: taker,
      encoding: "utf8",
    });
    expect(pushed.status, `${pushed.stderr}`).toBe(0);
    expect(
      spawnSync("git", ["--git-dir", origin, "rev-parse", BRANCH], {
        encoding: "utf8",
      }).stdout.trim(),
      "引き継いだ作業が上流に載っていない",
    ).toBe(tip);
  });

  it("PR を作るとき、head を明示している", () => {
    // **detached には「いまのブランチ」が無い**ので、**`gh pr create` の既定
    // （`[current branch]`）が取れない**——**`could not determine the current branch`
    // で PR が作れない**（実測）。**掴まなくした側が、こちらの前提を壊している。**
    const creates = commandLines().filter((line) => line.startsWith("gh pr create"));
    expect(creates.length, "手順書に PR の作成が無い").toBeGreaterThan(0);

    for (const create of creates) {
      expect(create, "detached では、いまのブランチを既定にできない").toContain("--head");
    }
  });

  it("手順書に、ブランチを掴むコマンドが残っていない", () => {
    // **捨てると決めたなら、捨て漏れが無いことを見る**（#186 と同じ形。Issue #102 の
    // 完了条件）。**1 箇所ずつ直すと、次に足された経路がまた掴む**——
    // **「掴まない」を性質として押さえる。**
    const grabbing = commandLines().filter(
      (line) =>
        /^(git (switch|checkout)|gh pr checkout)\b/.test(line) && !line.includes("--detach"),
    );

    expect(grabbing, "ブランチを掴むので、別の作業場から引き継げない").toEqual([]);
  });
});
