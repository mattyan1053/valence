import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-commit-guard", import.meta.url));

/**
 * `main` の上での commit を止める（#68）。
 *
 * **2 回起きている。** どちらも **ブランチは切られており、その後 `main` へ戻されて**、
 * **`main` の上で commit された**。
 *
 * ```
 * 15:08:23 checkout: moving from main to feat/…      ← ブランチは作られた
 * 15:09:53 checkout: moving from feat/… to main      ← 戻された
 * 15:09:53 reset:    moving to origin/main
 * 15:13:52 commit:   ✨ feat: …                      ← main の上で commit
 * 15:15:59 reset:    moving to origin/main           ← 気づいて修復
 * ```
 *
 * **2 回とも、止めたのは仕組みではなく人である。** ループは何も知らないまま先へ進んだ。
 *
 * **原因ではなく結果を止める。** 原因（誰が `main` へ戻したか）は特定できていないので、
 * **commit しようとした時点で `main` に居るかどうか**だけを見る——
 * **「ブランチ作成の抜け」に寄せた検査は、実際に起きた経路を素通りする**。
 */
describe("bin/loop-commit-guard", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "commit-guard-"));
    git("init", "--quiet", "-b", "main", ".");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    writeFileSync(join(repo, "seed"), "seed\n");
    git("add", "seed");
    git("commit", "--quiet", "--no-verify", "-m", "seed");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function git(...args: string[]): string {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  }

  function guard(cwd = repo): { status: number; stderr: string } {
    const result = spawnSync(SCRIPT, [], { cwd, encoding: "utf8" });
    return { status: result.status ?? -1, stderr: result.stderr };
  }

  it("main の上なら止める", () => {
    const result = guard();

    expect(result.status, "main の上なのに通している").toBe(1);
  });

  it("ブランチを切ったあとに main へ戻された状態でも止まる", () => {
    // **実際に 2 回起きたのはこの経路である。** ブランチは作られているので、
    // **「ブランチを切ったか」を見る検査は、ここで素通りする**
    git("switch", "--quiet", "-c", "feat/something");
    git("switch", "--quiet", "main");
    git("reset", "--quiet", "--hard", "HEAD");

    expect(guard().status, "戻された経路を素通りしている").toBe(1);
  });

  it("止まったときに、次に何をすればよいかが出る", () => {
    // **止めるだけでは、止まった側は何をすればよいか分からない。**
    // **ブランチを切り直して commit しなおす**ところまで書く（完了条件の 3 つ目）
    const stderr = guard().stderr;

    expect(stderr, "何が起きたのかが出ていない").toContain("main");
    expect(stderr, "次の手が出ていない").toMatch(/git switch -c/);
  });

  it("ブランチの上なら通す", () => {
    // **止める側だけを見ない。** 通る道で止めては、何も進まない
    git("switch", "--quiet", "-c", "feat/work");

    expect(guard().status, "ブランチの上なのに止めている").toBe(0);
  });

  it("detached HEAD は通す", () => {
    // **`main` ではないので、この検査の対象ではない。** **rebase は detached の
    // まま commit する**ので、ここで止めると **手順書の `git rebase origin/main` が
    // 落ちる**——**塞ぐ側が、通る道を塞ぐ**形になる
    git("switch", "--quiet", "--detach", "HEAD");

    expect(guard().status, "rebase の途中で止まる").toBe(0);
  });

  it("読めなければ、通す側に倒さない", () => {
    // **「分からない」を「ブランチの上に居る」と読まない**（#136 と同じ家族）。
    // **commit は止まるが、止まった理由は出力に残る**
    const outside = mkdtempSync(join(tmpdir(), "commit-guard-outside-"));
    try {
      expect(guard(outside).status, "リポジトリの外なのに通している").toBe(2);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
