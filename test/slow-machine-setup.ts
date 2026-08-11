/**
 * プロセスを起こす試験に、負荷の注記を付ける（`vitest.config.ts` から読まれる）。
 *
 * **判断は `loadNote` が持つ。** ここは値を集めて渡すだけにしてある——
 * 条件をここへ書くと、**vitest を実際に落とさないと確かめられない**ものになる。
 */
import { availableParallelism, loadavg } from "node:os";
import { afterEach } from "vitest";
import { loadNote, SCRIPT_TEST_TIMEOUT_MS } from "./slow-machine";

afterEach((context) => {
  const result = context.task.result;
  if (result?.state !== "fail") {
    return;
  }
  const note = loadNote({
    name: context.task.name,
    durationMs: result.duration ?? 0,
    timeoutMs: SCRIPT_TEST_TIMEOUT_MS,
    load1: loadavg()[0] ?? 0,
    cpus: availableParallelism(),
  });
  if (note !== null) {
    console.warn(note);
  }
});
