/**
 * **印のずれには向きが 2 つある**（#369）。
 *
 * **入口 1.0 が想定していたのは片方だけ**である——**配られた手順書が古い**。
 * **逆がある**: **自分の PR の枝に居ると、ディスクのほうが新しい。**
 * **そのときは呼び直しても揃わない**（**配られるのは main の印**）ので、
 * **2 回目で `procedure-stale` へ落ち、3 周で `loop/STOP` が配られる。**
 *
 * **見るのは「書いてあること」だけではない。** **手順書に書いてあるとおりに走らせて、
 * 実際に揃うこと**を見る——**書き写した手順は、実物が変わっても緑のまま**である
 * （#181 / #183 と同じ理由）。
 *
 * **走らせるだけでも足りない**（#370 のレビュー）。**踏む形を入力に入れる**——
 * **clean な git と、成功する `fetch` しか置かなければ、「動く条件では動いていた」しか
 * 言えない。** **dirty と、戻れない `origin` を置く。**
 */

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { procedureText } from "./procedure-doc";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 入口の 1.0（作業場を押さえるところ）だけを切り出す。 */
function entrySection(): string {
  const section = procedureText("worker").split("### 1.0 ")[1]?.split("\n### ")[0];
  if (section === undefined) {
    throw new Error("入口に 1.0 の節がありません");
  }
  return section;
}

/**
 * **枝から戻る手順**の bash ブロック。**書き写さない**——
 * **写すと、手順書を直さなくても緑のまま通る。**
 */
function recoveryBlock(): string {
  const found = entrySection()
    .split("```bash")
    .slice(1)
    .map((chunk) => chunk.split("```")[0] ?? "")
    .filter(
      (chunk) => chunk.includes("bin/loop-sync-main") && chunk.includes("bin/loop-procedure-stamp"),
    );
  expect(found, "枝から戻る手順が 1 つに絞れない").toHaveLength(1);
  return found[0] ?? "";
}

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  const done = spawnSync(
    "git",
    ["-c", "user.email=loop@example.invalid", "-c", "user.name=loop", ...args],
    { cwd, encoding: "utf8" },
  );
  expect(done.status, done.stderr).toBe(0);
  return done.stdout.trim();
}

/**
 * **実物のスクリプトを置く。** **偽物にすると「呼んでいるのに何も見ていない」形が
 * 緑になる**（#227）。
 */
function placeScripts(workspace: string): void {
  const bin = join(workspace, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of [
    "loop-sync-main",
    "loop-procedure-stamp",
    "loop-procedure-changed",
    "loop-stall",
    // **`bin/loop-stall` は作業場の名前を `bin/loop-lease` に訊く**（#239）
    "loop-lease",
  ]) {
    const target = join(bin, name);
    copyFileSync(join(REPO_ROOT, "bin", name), target);
    chmodSync(target, 0o755);
  }
}

function writeEntry(workspace: string, body: string): void {
  mkdirSync(join(workspace, ".claude", "commands"), { recursive: true });
  writeFileSync(
    join(workspace, ".claude", "commands", "loop-worker.md"),
    `<!-- 版: 000000000000 -->\n${body}\n`,
  );
}

/** いまディスクにある手順書の印。 */
function stampOf(workspace: string): string {
  const done = spawnSync(join(workspace, "bin/loop-procedure-stamp"), ["worker"], {
    cwd: workspace,
    encoding: "utf8",
  });
  expect(done.status, done.stderr).toBe(0);
  return done.stdout.trim();
}

function headOf(workspace: string): string {
  return git(workspace, "rev-parse", "HEAD");
}

/**
 * **`main` と、そこから分かれた枝**を持つ作業場。**HEAD は枝の上**に置く
 * ——**前の周回が自分の PR の枝で終わった状態**である。
 */
function parkedOnBranch(): { workspace: string; mainStamp: string } {
  const parent = mkdtempSync(join(tmpdir(), "branch-recovery-"));
  sandboxes.push(parent);
  const origin = join(parent, "origin.git");
  const workspace = join(parent, "valence");
  expect(spawnSync("git", ["init", "--bare", "--quiet", "-b", "main", origin]).status).toBe(0);
  expect(spawnSync("git", ["clone", "--quiet", origin, workspace]).status).toBe(0);
  placeScripts(workspace);
  writeEntry(workspace, "main の手順書");
  git(workspace, "add", "-A");
  git(workspace, "commit", "--quiet", "-m", "main");
  git(workspace, "push", "--quiet", "origin", "main");
  const mainStamp = stampOf(workspace);

  // **自分の PR の枝**（入口を直している PR。ディスクのほうが新しい）
  writeEntry(workspace, "枝の手順書（入口を直している）");
  git(workspace, "commit", "--quiet", "-a", "-m", "枝");
  git(workspace, "switch", "--detach", "--quiet", "HEAD");
  expect(stampOf(workspace), "枝と main の印が同じでは、入力になっていない").not.toBe(mainStamp);
  return { workspace, mainStamp };
}

/** **その作業場を押さえる**（印がずれている状態から押さえる口）。**token を返す。** */
function recoverIn(workspace: string, stamp: string): string {
  const done = spawnSync(join(workspace, "bin/loop-lease"), ["recover", "worker", stamp], {
    cwd: workspace,
    encoding: "utf8",
  });
  expect(done.status, done.stderr).toBe(0);
  return done.stdout.trim();
}

/** いま、この作業場の lease を誰かが握っているか。 */
function heldIn(workspace: string): boolean {
  return (
    spawnSync(join(workspace, "bin/loop-lease"), ["held", "worker"], {
      cwd: workspace,
      encoding: "utf8",
    }).status === 0
  );
}

function runRecovery(workspace: string, stamp: string, token = "token") {
  return spawnSync(
    "bash",
    ["-c", recoveryBlock().replaceAll("<読んだ印>", stamp).replaceAll("<token>", token)],
    {
      cwd: workspace,
      encoding: "utf8",
      // **上限には触れさせない**——**止めたいのではなく、何を記録するかを見たい**
      env: { ...process.env, LOOP_MAX_STALL_REPEATS: "9" },
    },
  );
}

describe("ディスクのほうが新しいとき、手順書に次の一手がある", () => {
  it("枝から戻る手順が、入口 1.0 に書いてある", () => {
    // **これが無いと、書いてある回復（呼び直す）を素直にやって人待ちへ落ちる**
    expect(recoveryBlock()).toContain("bin/loop-sync-main");
    expect(recoveryBlock(), "戻したあとに確かめていない").toContain("bin/loop-procedure-stamp");
  });

  it("これまでの向き（配られたものが古い）の扱いは変えない", () => {
    // **戻しても揃わないときは、これまでどおり捨てて呼び直す**——
    // **入口を触る PR がマージされた直後がそれ**である
    expect(entrySection(), "捨てて呼び直す道が消えている").toContain("捨てて呼び直す");
    expect(entrySection(), "2 回目に数える道が消えている").toContain(
      "bin/loop-stall procedure-stale",
    );
  });

  it("master の入口は触っていない", () => {
    // **master は checkout しない設計**なので、**この形は起きない**（#369）
    expect(procedureText("master"), "master 側にも入れている").not.toContain("#369");
  });
});

describe("書いてある手順で、実際に揃う", () => {
  it("枝に居ても、書いてある手順で印が揃う", () => {
    const { workspace, mainStamp } = parkedOnBranch();

    const done = runRecovery(workspace, mainStamp);

    expect(done.status, `${done.stdout}\n${done.stderr}`).toBe(0);
    expect(stampOf(workspace), "戻したのに印が揃っていない").toBe(mainStamp);
  });

  it("戻しても揃わないなら、揃ったと言わない", () => {
    // **入口を触る PR がマージされた直後**がこれである——**配られたものが本当に古い。**
    // **ここで 0 を返すと、古い手順のまま走る**（止める判断が崩れる）
    const { workspace } = parkedOnBranch();

    const done = runRecovery(workspace, "ffffffffffff");

    expect(done.status, "揃っていないのに続けてよいと答えている").not.toBe(0);
  });
});

/**
 * **踏む形を入力に入れる**（#370 のレビュー）。
 *
 * **前の版は「動く条件でだけ」確かめていた**——**用意した git は clean で、
 * `fetch` も成功していた。** **入力をそこから外すと、「dirty なら落ちる」も
 * 「同期の失敗を分ける」も成り立っていなかった。**
 */
describe("戻れない入力でも、正しいものを記録する", () => {
  it("残っているものがあるなら、枝から離れない", () => {
    // **`git switch --detach` は、衝突しない未コミットの変更を持ったまま HEAD を移す**
    // ——**1.1 の clean 検査に着く前に枝から離れ**、
    // **どの枝の上での作業だったかが失われる**
    const { workspace, mainStamp } = parkedOnBranch();
    writeFileSync(join(workspace, "作業中"), "書きかけ\n");
    const parked = headOf(workspace);

    const done = runRecovery(workspace, mainStamp);

    expect(headOf(workspace), "残っているのに枝から離れた").toBe(parked);
    expect(done.stdout + done.stderr, "dirty を記録していない").toContain("dirty");
  });

  it("同期に失敗したら、印ずれとして数えない", () => {
    // **枝の上なら印は当然ずれる**ので、**`main-sync-failed` が「配られたものが古い」に
    // 化ける**——**2 回目で `procedure-stale` を積み、本当の原因はどこにも残らない**
    const { workspace, mainStamp } = parkedOnBranch();
    git(workspace, "remote", "set-url", "origin", join(workspace, "居ない-origin.git"));

    const done = runRecovery(workspace, mainStamp);

    expect(done.stdout + done.stderr, "同期の失敗を記録していない").toContain("main-sync-failed");
  });
});

/**
 * **押さえたまま終わらない**（#370 のレビュー 2 周目）。
 *
 * **入口 1.0 は「何もせず終わる場合も含めて必ず返す」と書いている。** **握ったまま
 * 終えると、次の周回は期限が切れるまで `acquire` に拒まれる**——**master が 1 度
 * これで 98 分止めている。** **当たる場面も悪い**: **`main-sync-failed` は
 * 一時的な失敗**で、**すぐ試し直せば通ることが多い**のに、**そこで 30 分待つ。**
 *
 * **lease を取った状態から走らせて、終わったあとに握られていないことを見る**
 * ——**ブロックだけを走らせると、この残留は見えない。**
 */
describe("戻れない入力でも、作業場を握ったまま終わらない", () => {
  it("残っているものがあるときも、返してから終わる", () => {
    const { workspace, mainStamp } = parkedOnBranch();
    writeFileSync(join(workspace, "作業中"), "書きかけ\n");
    const token = recoverIn(workspace, mainStamp);
    expect(heldIn(workspace), "押さえられていない（入力になっていない）").toBe(true);

    runRecovery(workspace, mainStamp, token);

    expect(heldIn(workspace), "握ったまま終わっている").toBe(false);
  });

  it("同期に失敗したときも、返してから終わる", () => {
    const { workspace, mainStamp } = parkedOnBranch();
    git(workspace, "remote", "set-url", "origin", join(workspace, "居ない-origin.git"));
    const token = recoverIn(workspace, mainStamp);
    expect(heldIn(workspace), "押さえられていない（入力になっていない）").toBe(true);

    runRecovery(workspace, mainStamp, token);

    expect(heldIn(workspace), "握ったまま終わっている").toBe(false);
  });
});
