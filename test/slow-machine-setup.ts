/**
 * プロセスを起こす試験に、負荷の注記を付ける（`vitest.config.ts` から読まれる）。
 *
 * **判断は `loadNote` が持つ。** ここは値を集めて渡すだけにしてある——
 * 条件をここへ書くと、**vitest を実際に落とさないと確かめられない**ものになる。
 */
import { availableParallelism, loadavg } from "node:os";
import { afterEach } from "vitest";
import { z } from "zod";
import { loadNote, SCRIPT_TEST_TIMEOUT_MS } from "./slow-machine";

/**
 * `afterEach` で読める結果のうち、**時刻として使える部分**。
 *
 * **`duration` は使えない**（この時点では未記録で、実測すると `undefined`）。
 * `startTime` は vitest の内部表現なので、**型を信じず検証してから使う**——
 * 版が上がって消えたら、**注記が黙って嘘をつく**（0 ms で失敗、と出ていた）。
 */
const startedAtShape = z.object({ startTime: z.number() });

/**
 * その試験に実際に与えられていた枠。
 *
 * **project の既定で代用しない。** 自分で枠を宣言している試験（`budgetFor(n)`）を
 * 既定で判定すると、**時間切れなのに「◯◯ ms で失敗」と出る**（実測で踏んだ）。
 * 取れないときだけ既定へ落とす。
 */
const timeoutShape = z.object({ timeout: z.number() });

afterEach((context) => {
  const result = context.task.result;
  if (result?.state !== "fail") {
    return;
  }
  const started = startedAtShape.safeParse(result);
  const budget = timeoutShape.safeParse(context.task);
  const note = loadNote({
    name: context.task.name,
    startedAt: started.success ? started.data.startTime : undefined,
    finishedAt: Date.now(),
    timeoutMs: budget.success ? budget.data.timeout : SCRIPT_TEST_TIMEOUT_MS,
    load1: loadavg()[0] ?? 0,
    cpus: availableParallelism(),
  });
  if (note !== null) {
    console.warn(note);
  }
});
