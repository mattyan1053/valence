import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-keep-branch", import.meta.url));

/**
 * **detached で作った commit を、ブランチ名の側へ残す** (#102 のレビュー)。
 *
 * **worker はブランチを掴まなくなった**ので、**push が落ちると、その周回の commit を
 * 指すものが 1 つも無い**——**次の周回は冒頭で `origin/main` へ移るので、
 * どこからも辿れなくなる**。**通信障害や non-fast-forward は、worker が 1 人でも起きる。**
 *
 * **push は 3 箇所ある**（rebase・対応後・PR を作る）。**1 箇所ずつ書くと、
 * 次に足された push が抜ける**——**実際に 1 箇所だけになっていた**ので、
 * **1 つにまとめて、置き忘れは手順書の走査で見る。**
 */
describe("bin/loop-keep-branch", () => {
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
      { cwd, encoding: "utf8" },
    );
  }

  /** detached で commit を積んだ作業場。 */
  function workspace(): string {
    const root = mkdtempSync(join(tmpdir(), "loop-keep-branch-"));
    roots.push(root);
    expect(spawnSync("git", ["init", "--quiet", "-b", "main", root]).status).toBe(0);
    expect(git(["commit", "--allow-empty", "--quiet", "-m", "init"], root).status).toBe(0);
    expect(git(["switch", "--detach", "--quiet", "HEAD"], root).status).toBe(0);
    expect(git(["commit", "--allow-empty", "--quiet", "-m", "この周回の作業"], root).status).toBe(
      0,
    );
    return root;
  }

  function keep(cwd: string, ...args: string[]) {
    return spawnSync(SCRIPT, args, { cwd, encoding: "utf8" });
  }

  it("detached の commit を、ブランチ名から辿れるようにする", () => {
    const root = workspace();

    const kept = keep(root, BRANCH);

    expect(kept.status, kept.stderr).toBe(0);
    expect(git(["rev-parse", BRANCH], root).stdout.trim(), "ブランチが HEAD を指していない").toBe(
      git(["rev-parse", "HEAD"], root).stdout.trim(),
    );
  });

  it("既にあるブランチも、この周回の先まで進める", () => {
    // **1 度 push に失敗した周回は、次の周回で続きを積む**——**古い位置に置き去りにすると、
    // 拾える範囲がその時点で止まる**
    const root = workspace();
    expect(keep(root, BRANCH).status).toBe(0);
    expect(git(["commit", "--allow-empty", "--quiet", "-m", "続き"], root).status).toBe(0);

    const kept = keep(root, BRANCH);

    expect(kept.status, kept.stderr).toBe(0);
    expect(git(["rev-parse", BRANCH], root).stdout.trim()).toBe(
      git(["rev-parse", "HEAD"], root).stdout.trim(),
    );
  });

  it("別の作業場が掴んでいても、止めない", () => {
    // **引き継いだ周回は、掴んでいる作業場と同じ commit にいる**（2.2 は
    // `git switch --detach <ブランチ>` で入り、commit を足さない）——
    // **進めるものが無いので、失うものも無い。**
    //
    // **ここで止めると、引き継ぎを直したこの変更自身が、引き継ぎを止める。**
    const root = workspace();
    expect(git(["switch", "--quiet", "-c", BRANCH], root).status).toBe(0);
    const held = `${root}-worker-a`;
    expect(git(["worktree", "add", "--detach", "--quiet", held, BRANCH], root).status).toBe(0);
    const tip = git(["rev-parse", "HEAD"], held).stdout.trim();

    const kept = keep(held, BRANCH);

    expect(kept.status, "引き継ぎを止めている").toBe(0);
    // **掴んでいる側の足元を動かしていない**（`git update-ref` なら通るが、
    // **その作業場の HEAD を黙って動かす**。`AGENTS.md` §5）
    expect(git(["rev-parse", BRANCH], root).stdout.trim(), "掴んでいる側のブランチが動いた").toBe(
      tip,
    );
  });

  it("掴んでいる側が先にいても、止めない", () => {
    // **ブランチの側が既にこの commit を含んでいる**なら、**進めなくても辿れる**。
    // **黙らない**——**進められなかったことは、読む人に見えている必要がある。**
    const root = workspace();
    expect(git(["switch", "--quiet", "-c", BRANCH], root).status).toBe(0);
    const held = `${root}-worker-a`;
    expect(git(["worktree", "add", "--detach", "--quiet", held, BRANCH], root).status).toBe(0);
    // **掴んでいる側が先へ進んだ**（こちらの HEAD は、その祖先になる）
    expect(
      git(["commit", "--allow-empty", "--quiet", "-m", "掴んでいる側が進めた"], root).status,
    ).toBe(0);

    const kept = keep(held, BRANCH);

    expect(kept.status, "失われないのに、止めている").toBe(1);
    expect(kept.stdout, "進められなかったことが、どこにも出ていない").toContain("[INFO]");
  });

  it("掴まれていて、しかも進める必要があるなら、回収用 ref に置く", () => {
    // **引き継ぎの場面にだけ、網が無かった**（#202 のレビュー 2 周目）——
    // **相手が既に 1 度落ちている、いちばん壊れやすい場面**である。
    //
    // **`git update-ref` を別の名前空間に使う。** **退けた理由（掴んでいる作業場の
    // HEAD を黙って動かす）には当たらない**——**ブランチではない**からである。
    const root = workspace();
    expect(git(["switch", "--quiet", "-c", BRANCH], root).status).toBe(0);
    const held = `${root}-worker-a`;
    expect(git(["worktree", "add", "--detach", "--quiet", held, BRANCH], root).status).toBe(0);
    const tip = git(["rev-parse", "HEAD"], root).stdout.trim();
    expect(git(["commit", "--allow-empty", "--quiet", "-m", "こちらで積んだ"], held).status).toBe(
      0,
    );
    const made = git(["rev-parse", "HEAD"], held).stdout.trim();

    const kept = keep(held, BRANCH);

    expect(kept.status, `push へ到達できない: ${kept.stderr}`).toBe(0);
    expect(kept.stdout, "どこへ置いたのかが、どこにも出ていない").toContain("[INFO]");
    // **掴んでいる側のブランチは動かしていない**
    expect(git(["rev-parse", BRANCH], root).stdout.trim(), "掴んでいる側のブランチが動いた").toBe(
      tip,
    );
    // **置いただけで誰も見ないなら、置いていないのと同じ**——**読む側から確かめる**
    expect(git(["switch", "--detach", "--quiet", "HEAD~1"], held).status).toBe(0);
    const entered = keep(held, "--enter", BRANCH);
    expect(entered.status, entered.stderr).toBe(0);
    expect(git(["rev-parse", "HEAD"], held).stdout.trim(), "積んだ commit へ戻れない").toBe(made);
  });

  it("回収用 ref より、ブランチが先にいるなら、ブランチへ入る", () => {
    // **倒す先は 2 つある**——**置く側と読む側**。**古い回収用 ref へ入ると、
    // その後の周回で積んだものが、また置き去りになる。**
    const root = workspace();
    expect(git(["switch", "--quiet", "-c", BRANCH], root).status).toBe(0);
    const held = `${root}-worker-a`;
    expect(git(["worktree", "add", "--detach", "--quiet", held, BRANCH], root).status).toBe(0);
    expect(git(["commit", "--allow-empty", "--quiet", "-m", "こちらで積んだ"], held).status).toBe(
      0,
    );
    expect(keep(held, BRANCH).status).toBe(0);
    // **掴んでいた作業場が、そのぶんも取り込んで先へ進んだ**
    expect(git(["merge", "--quiet", "--ff-only", "HEAD"], root).status).toBe(0);
    expect(
      git(["reset", "--hard", "--quiet", git(["rev-parse", "HEAD"], held).stdout.trim()], root)
        .status,
    ).toBe(0);
    expect(git(["commit", "--allow-empty", "--quiet", "-m", "その先"], root).status).toBe(0);
    const ahead = git(["rev-parse", "HEAD"], root).stdout.trim();

    const entered = keep(held, "--enter", BRANCH);

    expect(entered.status, entered.stderr).toBe(0);
    expect(git(["rev-parse", "HEAD"], held).stdout.trim(), "古い回収用 ref へ入っている").toBe(
      ahead,
    );
  });

  it("入る先が無ければ、入ったふりをしない", () => {
    const root = workspace();

    const entered = keep(root, "--enter", "fix/どこにも無い");

    expect(entered.status, "入る先が無いのに成功している").toBe(1);
  });

  it("ブランチ名が無ければ、使い方を出して止まる", () => {
    const root = workspace();

    expect(keep(root).status, "何を進めるか分からないまま成功している").toBe(2);
  });
});
