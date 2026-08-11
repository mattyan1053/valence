/**
 * ロックを握らせたまま試験を走らせる仕掛け。
 *
 * **試験が起こしたプロセスは、試験がどう死んでも生き残ってはいけない**（#153）。
 * 実測で **41 本が最大 19 時間**動き続け、1 コアの機械で load average が **49** に達した。
 * しかも**自己増幅する**——負荷が上がる → 枠を破る → 打ち切られる → 後始末が走らない →
 * さらに漏れる。**枠を広げる側（#131 / #137 / #141 / #152）は症状への対処**で、原因はここ。
 *
 * **後始末に頼らない。** `finally` も `trap` も、**打ち切られた経路では走らない**
 * （vitest はワーカーごと落とす）。**外から掛ける安全装置**が要る。
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

/** 待機側が生き残れる上限（秒）。 */
export const HOLD_LIMIT_SEC = 20;

/** 握らせたロック。**解放は 1 度だけ呼べばよい**（冪等）。 */
export type HeldLock = {
  readonly release: () => void;
};

type HoldPaths = {
  /** 握らせるロックファイル。 */
  lock: string;
  /** 握ったことを知らせる印（普通のファイル）。 */
  ready: string;
  /** 解放を知らせる先。 */
  release: string;
  /** 待機側が生き残れる上限（秒）。 */
  limitSeconds: number;
};

/**
 * 保持側を起こすシェル。**これが唯一の正**で、`bin/*.test.ts` はここから受け取る。
 *
 * 2 箇所に書くと、**片方だけ直して漏れる側が残る**（実際に `bin/loop-claim.test.ts` と
 * `bin/loop-stall.test.ts` に同型が並んでいた）。
 */
export function holdingCommand(paths: HoldPaths): string {
  const { lock, ready, release, limitSeconds } = paths;
  // **待つのは `read` の組み込みの上限だけ。**
  //
  //   - **`read -t` が安全装置である。** シェル自身が持つ上限なので、**外から誰も
  //     何もしなくても**この秒数を超えて生き残れない。**打ち切られた経路でも効く**
  //   - **`<>` で開く。** FIFO を読み取りだけで開くと**書き手が現れるまで open で止まり**、
  //     **`read -t` はそこまで届かない**——**上限を置いたつもりで、無限に待つ**
  //   - **総当たりで待たない。** `while … sleep 0.02` は**反復ごとにプロセスを起こす**
  //   - **`setsid` を使わない。** 切り離しておいて個別に kill しようとすると噛み合わない
  //     （実際、殺していたのは待っている当人ではなかった）。**呼ぶ側がグループごと落とす**
  const body = [
    `mkfifo ${JSON.stringify(release)} 2>/dev/null`,
    `touch ${JSON.stringify(ready)}`,
    `read -t ${limitSeconds} -r _ <>${JSON.stringify(release)}`,
  ].join("; ");
  // **`flock -c` を使わない。** `-c` の本体は **`sh` で走る**ので、
  // **`read -t` が「不正なオプション」で即座に落ちる**——**握らないまま先へ進み、
  // ロックを取らない実装まで緑になる**（実際に踏んだ）。**bash を直接渡す。**
  return `flock -x ${JSON.stringify(lock)} /usr/bin/bash -c ${JSON.stringify(body)}`;
}

/**
 * シェルの中から保持側を起こす断片。**背景に置くので、呼ぶ側が `$!` を受け取れる。**
 *
 * **Node から握らせる場合は `holdLock` を使う。** こちらは、**保持している間に
 * 同じ bash の中で別のものを走らせたい**場合のためにある（`bin/loop-stall.test.ts`）。
 *
 * **知らせ方に注意がある。** `echo x > FIFO` は**読み手が現れるまで open で止まる**ので、
 * **親が先に死ぬと、そこで永久に止まる**。**開いたまま持つ**（`exec 3<>`）と
 * **止まらず、しかも書いたものが消えない**（fd を持っている間はバッファに残る）。
 */
export function holdingSnippet(paths: {
  lock: string;
  /** 握ったことを知らせる FIFO。 */
  held: string;
  /** 解放を知らせる FIFO。 */
  release: string;
  limitSeconds?: number;
}): string {
  const limit = paths.limitSeconds ?? HOLD_LIMIT_SEC;
  const body = `exec 3<>"${paths.held}"; echo x >&3; read -t ${limit} -r _ <>"${paths.release}"`;
  // **`flock -c` を使わない**（本体が `sh` で走り、`read -t` が落ちる）。
  // **`setsid` で切り離すのは、外側の bash が上限で殺されても知らせを届けるため**で、
  // **後始末は呼ぶ側の `trap` が担う**。届かなかったときの受け皿が上の `read -t` である。
  return `setsid flock -x '${paths.lock}' /usr/bin/bash -c '${body}' </dev/null >/dev/null 2>&1 &`;
}

/**
 * プロセスを起こさずに眠る。
 *
 * **`spawnSync("sleep", …)` で待たない。** この機械は**プロセス起動 1 回が 219–1004 ms**
 * （実測）なので、**待っている間ずっと起動し続ける**ことになる。**これは漏れないが焼く**
 * ので、掃除しても消えない。
 */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 条件が満たされるまで待つ。**満たされたかどうかを返す**（時間切れでも投げない）。 */
export function waitUntil(done: () => boolean, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done()) {
      return true;
    }
    sleepSync(20);
  }
  return done();
}

/**
 * その文字列を含むコマンドラインで動いているプロセスの数。
 *
 * **`pgrep` を起こさない**（数えるためにプロセスを起こしては本末転倒である）。
 * `/proc` を直接読む——この仕組みは Linux のコンテナでしか動かない。
 */
export function processCount(marker: string): number {
  let found = 0;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      if (readFileSync(join("/proc", entry, "cmdline"), "utf8").includes(marker)) {
        found++;
      }
    } catch {
      // 読む前に消えたプロセス。数えない
    }
  }
  return found;
}

/**
 * ロックを握らせる。**握れたことを確かめてから返る。**
 *
 * **握れていないまま返さない。** 握っていない状態で本体を走らせると、
 * **「ロックを取らない実装」でも試験が通る**——確認そのものが空振りする（#152）。
 */
export function holdLock(options: {
  /** 使い捨てのディレクトリ。**印もここへ置く。** */
  dir: string;
  /** 握らせるロックファイル。 */
  lock: string;
  /** 待機側の上限（秒）。試験で短くできるようにしてある。 */
  limitSeconds?: number;
}): HeldLock {
  const { dir, lock } = options;
  const limitSeconds = options.limitSeconds ?? HOLD_LIMIT_SEC;
  const ready = join(dir, "lock.ready");
  const release = join(dir, "lock.release");

  // **`spawn` で起こす。** `spawnSync` だと保持側が終わるまで返らないので、
  // **背景に置いて PID を echo する**形になり、**受け取るのは待っている当人ではない**
  // （`$!` が指すのは切り離した側だった）。ここでは **Node が本物の PID を持つ**。
  //
  // **`detached` にするのは、グループごと落とすため**である。`flock` を殺しても
  // **その下のシェルは残る**ので、**片方だけ殺す形にしない**。
  const holder = spawn(
    "/usr/bin/bash",
    ["-c", holdingCommand({ lock, ready, release, limitSeconds })],
    { cwd: dir, detached: true, stdio: "ignore" },
  );
  holder.unref();
  const pid = holder.pid;

  if (!waitUntil(() => existsSync(ready), limitSeconds * 1_000)) {
    killGroup(pid);
    throw new Error(`ロックを握れていない: ${lock}`);
  }

  let released = false;
  return {
    release: () => {
      if (released) {
        return;
      }
      released = true;
      // **知らせてから落とす。** 知らせだけだと、届かなかったときに上限まで残る
      try {
        // **`r+` で開く。** 書き込み専用で開くと、**読み手が居ないときに open で止まる**
        const fifo = openSync(release, "r+");
        writeSync(fifo, "x\n");
        closeSync(fifo);
      } catch {
        // 保持側が既に消えている
      }
      killGroup(pid);
    },
  };
}

/** プロセスグループごと落とす。**既に居なければ何もしない。** */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // もう居ない
  }
}
