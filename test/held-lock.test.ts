import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HOLD_LIMIT_SEC,
  holdingCommand,
  holdLock,
  processCount,
  sleepSync,
  waitUntil,
} from "./held-lock";
import { SCRIPT_TEST_TIMEOUT_MS } from "./slow-machine";

describe("ロックを握らせる仕掛け", () => {
  let dir: string;
  let lock: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "held-lock-"));
    lock = join(dir, "held.lock");
    spawnSync("/usr/bin/touch", [lock]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("握っている間はロックが取れず、解放すれば取れる", () => {
    // **仕掛けそのものが効いていることを先に見る。** 握れていない仕掛けは、
    // **「ロックを取らない実装」まで緑にする**——確認が空振りする形（#152）
    const held = holdLock({ dir, lock });

    const busy = spawnSync("/usr/bin/flock", ["-n", lock, "-c", "true"], { encoding: "utf8" });
    held.release();
    const free = waitUntil(
      () => spawnSync("/usr/bin/flock", ["-n", lock, "-c", "true"]).status === 0,
      10_000,
    );

    expect(busy.status, "握っていない（仕掛けが効いていない）").not.toBe(0);
    expect(free, "解放しても取れないまま").toBe(true);
  });

  it("後始末が 1 度も走らなくても、待機側は自分の上限で消える", () => {
    // **これが本体である。** `finally` も `trap` も**打ち切られた経路では走らない**
    // （vitest はワーカーごと落とす）。**誰も殺さない状態**を作って、
    // **待機側が自分から消えること**を見る。
    //
    // **切り離して起こす**（`detached`）ので、**この試験のプロセスグループを落としても
    // 届かない**——**外からの後始末が 1 度も届かない状態**である。
    const ready = join(dir, "lock.ready");
    const holder = spawn(
      "/usr/bin/bash",
      ["-c", holdingCommand({ lock, ready, release: join(dir, "lock.release"), limitSeconds: 3 })],
      { cwd: dir, detached: true, stdio: "ignore" },
    );
    holder.unref();

    expect(
      waitUntil(() => existsSync(ready), 20_000),
      "保持側が起動していない",
    ).toBe(true);
    // **上限より短い時点では、まだ生きている。** ここが 0 だと「起動しなかっただけ」で
    // 下の表明が通る——**空振りを緑にしない**
    expect(processCount(dir), "保持側が居ない（確認が空振りしている）").toBeGreaterThan(0);

    expect(
      waitUntil(() => processCount(dir) === 0, 20_000),
      "上限を過ぎても待機プロセスが残っている",
    ).toBe(true);
  });

  it("待つ側は、反復ごとにプロセスを起こさない", () => {
    // **漏れないが焼く。** この機械はプロセス起動 1 回が 219–1004 ms（実測）なので、
    // 20 ms ごとに `sleep` を起こすと**待っている間ずっと焼き続ける**——
    // **掃除では消えない負荷**である。**眠っている間、子プロセスは 1 つも増えない**
    const before = processCount("/usr/bin/sleep");

    const started = Date.now();
    sleepSync(300);
    const elapsed = Date.now() - started;

    expect(elapsed, "眠っていない").toBeGreaterThanOrEqual(280);
    expect(processCount("/usr/bin/sleep"), "待つために外のプロセスを起こしている").toBe(before);
  });

  it("既定の上限は、既定を使う側の枠より短い", () => {
    // **枠より長いと、ラッパーが打ち切られたあとも保持側が残る**——
    // **この PR が消しに来た積み残しが、上限の中に戻る。**
    //
    // **繋がっていない数字と比べない。** ここは以前 60 秒（**どこにも無い値**）と
    // 比べていて、**上限を 45 秒にしても通った**——**実際の枠は
    // `SCRIPT_TEST_TIMEOUT_MS`** なので、**それより長い上限は、超えたぶんだけ
    // 残るのに緑になる**。**使われている値そのものと比べる。**
    //
    // **これより短い枠が 1 つある**（`bin/loop-stall.test.ts`「上限で打ち切られても、
    // 保持側を残さない」の `ORPHAN_CUTOFF_MS`）**が、そこは既定を使っていない。**
    // **あの試験の主題は後始末そのもの**なので、**保持側が自分で消えると空振りする**——
    // だから**あそこだけ自分で長い上限を宣言し、残っていないことを直後に確かめている**。
    // 関係が崩れれば、その試験の中の表明が落ちる。
    expect(HOLD_LIMIT_SEC * 1_000).toBeLessThan(SCRIPT_TEST_TIMEOUT_MS);
  });
});
