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

  it("上限は、試験を打ち切る枠より短い", () => {
    // **枠より長いと、打ち切られた周回のぶんが必ず積み残る。**
    // ここが逆転したら、**漏れないという保証がそこで消える**
    expect(HOLD_LIMIT_SEC * 1_000).toBeLessThan(60_000);
  });
});
