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
import { procedureText } from "./procedure-doc";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * 手順書の bash ブロックを全部取り出す。**書き写さない**（#181 / #183）——
 * **写すと、手順書を直さなくても緑のまま通る**。
 */
function bashBlocks(): string[] {
  const body = procedureText("worker");
  return [...body.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
}

/** 手順書の行のうち、コマンドとして書かれているもの（コメント行を除く）。 */
function commandLines(): string[] {
  return bashBlocks()
    .flatMap((block) => block.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** **落ちた周回の続きへ入る**ブロック（ステップ 2.2）。 */
function resumeBlock(): string {
  const found = bashBlocks().filter((block) => block.includes("loop-keep-branch --enter"));
  expect(found, "落ちた周回の続きへ入るブロックが 1 つに絞れない").toHaveLength(1);
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
    withScripts(cwd);
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

  it("push の前で、必ずブランチ名を先へ進めている", () => {
    // **捨てると決めたなら、捨て漏れが無いことを見る**（掴むコマンドの走査と同じ形）。
    // **1 箇所ずつ直すと、次に足された push が抜ける。**
    for (const pair of pushPairs()) {
      expect(pair.split("\n").length, `push の前に何も無い: ${pair}`).toBe(2);
      expect(pair, "push が落ちると、この周回の commit が辿れなくなる").toMatch(
        /^bin\/loop-keep-branch\b/,
      );
    }
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

  /**
   * **`git push` と、その 1 つ前の行**（**順序ごと手順書から取り出す**）。
   *
   * **push は 3 箇所ある。** **1 箇所ずつ書くと、次に足された push が抜ける**——
   * **実際に 1 箇所だけになっていた**（#202 のレビュー）。
   */
  function pushPairs(): string[] {
    const found = bashBlocks().flatMap((block) => {
      const lines = block
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));
      return lines.flatMap((line, index) =>
        line.startsWith("git push")
          ? [lines.slice(Math.max(index - 1, 0), index + 1).join("\n")]
          : [],
      );
    });
    expect(found.length, "手順書に push が無い").toBeGreaterThan(0);
    return found;
  }

  /** 手順書のスクリプトを、使い捨ての作業場から呼べるようにする。 */
  function withScripts(cwd: string): void {
    mkdirSync(join(cwd, "bin"), { recursive: true });
    copyFileSync(join(REPO_ROOT, "bin", "loop-keep-branch"), join(cwd, "bin", "loop-keep-branch"));
    chmodSync(join(cwd, "bin", "loop-keep-branch"), 0o755);
  }

  /** push だけが落ちる `git`。**通信障害と non-fast-forward は、1 人でも起きる。** */
  function withFailingPush(cwd: string): NodeJS.ProcessEnv {
    const stubs = join(cwd, "stub");
    mkdirSync(stubs, { recursive: true });
    const real = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(
      join(stubs, "git"),
      [
        "#!/usr/bin/env bash",
        'if [[ $1 == "push" ]]; then',
        '  echo "fatal: unable to access: Could not resolve host" >&2',
        "  exit 128",
        "fi",
        `exec ${JSON.stringify(real)} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    return { ...process.env, PATH: `${stubs}:${process.env.PATH ?? ""}` };
  }

  it("push が落ちても、この周回の commit を辿れる", () => {
    // **掴まないと、push が落ちたときに commit を指すものが 1 つも無い**——
    // **次の周回は冒頭で `origin/main` へ移る**ので、**どこからも辿れなくなる**
    // （#202 のレビュー。**`main` は掴んでいたので、ローカルのブランチが拾っていた**）。
    //
    // **push は 3 箇所ある。** **「経路が複数あるなら、入力も複数要る」**——
    // **全部の push の前で確かめる**（**1 箇所だけ直すと、残りは静かに失われる**）
    const { taker } = workspaces();
    expect(git(["commit", "--allow-empty", "--quiet", "-m", "この周回の作業"], taker).status).toBe(
      0,
    );
    const made = git(["rev-parse", "HEAD"], taker).stdout.trim();
    withScripts(taker);
    const env = withFailingPush(taker);

    for (const [index, pair] of pushPairs().entries()) {
      const branch = `feat/落ちた-push-${index}`;
      const ran = spawnSync("bash", ["-c", pair.replaceAll("<ブランチ>", branch)], {
        cwd: taker,
        encoding: "utf8",
        env,
      });

      expect(ran.status, `push が落ちていない: ${pair}`).not.toBe(0);
      expect(
        git(["rev-parse", branch], taker).stdout.trim(),
        `push が落ちると辿れなくなる: ${pair}`,
      ).toBe(made);
    }
  });

  it("進められなくても、引き継ぎは止まらない", () => {
    // **掴まれているブランチは進められない**（`git branch -f` は exit 128）——
    // **引き継ぎを直したこの変更自身が、引き継ぎを止める**形になる。
    // **引き継いだ周回は、掴んでいる作業場と同じ commit にいる**ので、
    // **進めるものが無く、失うものも無い。**
    const { dead, taker, origin, tip } = workspaces();

    expect(runResume(taker).status).toBe(0);
    withScripts(taker);
    const pairs = pushPairs();
    const ran = spawnSync("bash", ["-c", (pairs[0] ?? "").replaceAll("<ブランチ>", BRANCH)], {
      cwd: taker,
      encoding: "utf8",
    });

    expect(ran.status, `${ran.stdout}${ran.stderr}`).toBe(0);
    // **掴んでいる側の足元を動かしていない**（`git update-ref` との違い）
    expect(git(["rev-parse", "HEAD"], dead).stdout.trim(), "掴んでいる作業場の HEAD が動いた").toBe(
      tip,
    );
    expect(
      spawnSync("git", ["--git-dir", origin, "rev-parse", BRANCH], {
        encoding: "utf8",
      }).stdout.trim(),
      "引き継いだ作業が上流に載っていない",
    ).toBe(tip);
  });

  it("引き継いだ周回が積んだ commit も、次の周回から辿れる", () => {
    // **引き継ぎの場面にだけ、網が無かった**（#202 のレビュー 2 周目）——
    // **掴まれているブランチは worktree 排他で進められない**ので、
    // **その周回の commit を指すものが 1 つも無くなる。**
    //
    // **相手が既に 1 度落ちている、いちばん壊れやすい場面**である。
    // **置く側と読む側を 1 組で見る**——**置いただけで誰も見ないなら、置いていないのと同じ。**
    const { taker } = workspaces();
    expect(runResume(taker).status).toBe(0);
    expect(
      git(["commit", "--allow-empty", "--quiet", "-m", "引き継いで直した"], taker).status,
    ).toBe(0);
    const made = git(["rev-parse", "HEAD"], taker).stdout.trim();
    const env = withFailingPush(taker);

    for (const pair of pushPairs()) {
      const ran = spawnSync("bash", ["-c", pair.replaceAll("<ブランチ>", BRANCH)], {
        cwd: taker,
        encoding: "utf8",
        env,
      });
      expect(ran.status, `push が落ちていない: ${pair}`).not.toBe(0);
    }
    // **次の周回のふり**をする（冒頭で `origin/main` へ移り、2.2 から入り直す）
    expect(git(["switch", "--detach", "--quiet", "origin/main"], taker).status).toBe(0);

    expect(runResume(taker).status, "引き継いだ周回の続きへ入れない").toBe(0);
    expect(git(["rev-parse", "HEAD"], taker).stdout.trim(), "積んだ commit へ戻れない").toBe(made);
  });

  it("checkout した先が PR の head かを、機械で確かめている", () => {
    // **`headRefOid` は手順書のどこにも出てこない値**である——**「一致することを
    // 確認する」と書いても、比べる相手がその場に無ければ実行されない**（#202 のレビュー）。
    // **判定は `bin/loop-head` が持っている**（2 箇所に持たない）。
    const checkout = bashBlocks().filter((block) => block.includes("gh pr checkout --detach"));
    expect(checkout.length, "PR へ入るブロックが無い").toBeGreaterThan(0);

    const compared = checkout.filter((block) => block.includes("bin/loop-head same"));

    expect(
      compared.length,
      "checkout した先が PR の head かを、機械で確かめていない",
    ).toBeGreaterThan(0);
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
