/**
 * 遅い機械で試験が落ちたときの扱い。
 *
 * **時間に依存する試験は、負荷で落ちる。しかも落ちる場所が走るたびに変わる**（#131）。
 * 実測（1 vCPU / load 34）では 3 回の実行で落ちた試験が 3 回とも違い、
 * **timeout に混ざって表明の破れまで出た**。`expected … to contain` は
 * **普通なら本物の不具合の顔**をしているので、外から区別が付かない。
 *
 * ここには 2 つ置いてある。
 *
 *   SCRIPT_TEST_TIMEOUT_MS … プロセスを起こす試験の枠。**回数から導く**
 *   loadNote               … 落ちたときに、負荷が原因だと分かる注記
 *
 * **前者が本体で、後者が保険である。** 枠だけでは「落ちなくなった」ことしか保証できず、
 * それでも落ちたときに**本物と見分ける手段が無い**。
 */

/**
 * 1 プロセスを起こすのにかかる最悪値（ミリ秒）。
 *
 * **実測**: 開発 VM（1 vCPU、load average 34）で `bin/loop-stall` を 5 回起こし、
 * 219 / 618 / 744 / 758 / 1004 ms。**同じ機械で 4.5 倍ばらつく**。
 */
const WORST_SPAWN_MS = 1_000;

/**
 * いちばん重い試験が起こすプロセスの数。
 *
 * `bin/loop-stall.test.ts` の `runNoWorkToLimit` が、
 * git init / add / commit / worktree add / worktree remove の 5 回に加えて
 * `bin/loop-stall` を 3〜4 回起こす。
 *
 * **減らせない。** 回数のほとんどは「使い捨ての git リポジトリと worktree を作る」ためで、
 * **`loop/STOP` が両方の worktree へ配られること**を見るのに要る。使い回すと
 * カウンタの状態が試験を跨いで漏れ、**この試験が守っているものが守れなくなる**。
 */
const WORST_SPAWNS = 9;

/**
 * 安全率。**ばらつきが 4.5 倍あるので、最悪値の上にさらに積む。**
 * これを 1 にすると「実測どおりなら間に合う」だけになり、**実測より悪い日に落ちる**。
 */
const MARGIN = 3;

/**
 * プロセスを起こす試験の枠。
 *
 * **伸ばした値ではなく、導いた値である。** vitest の既定 5 秒は
 * 「9 回 × 最悪 1 秒」の内側にあり、**間に合わない日があるのが当たり前**だった。
 * 回数か 1 回あたりの費用が変われば、ここも一緒に変わる。
 */
export const SCRIPT_TEST_TIMEOUT_MS = WORST_SPAWNS * WORST_SPAWN_MS * MARGIN;

export type LoadContext = {
  /** 落ちた試験の名前。並んだ出力の中で、どれに付いた注記か分かるようにする。 */
  name: string;
  /** 実際にかかった時間（ミリ秒）。 */
  durationMs: number;
  /** その試験に与えられていた枠（ミリ秒）。 */
  timeoutMs: number;
  /** loadavg の 1 分値。**実行待ちの数**であって使用率ではない。 */
  load1: number;
  /** 使える CPU の数。 */
  cpus: number;
};

/**
 * 落ちた試験に付ける注記。負荷のせいにできないときは `null`。
 *
 * **時間切れだけを対象にしない。** 負荷の下では表明も壊れるので、
 * **どんな落ち方でも**負荷が高ければ触れる。
 */
export function loadNote(context: LoadContext): string | null {
  // **CPU 数までは正常である。** 空いている機械で落ちたなら、それは本物である。
  // ここを緩めると、何でも「負荷のせい」で片付けられるようになる。
  if (context.load1 <= context.cpus) {
    return null;
  }
  const how =
    context.durationMs >= context.timeoutMs
      ? `枠 ${context.timeoutMs} ms に届かず時間切れ`
      : `${context.durationMs} ms で失敗`;
  return [
    `[負荷] ${context.name}`,
    how,
    `実行待ち ${context.load1.toFixed(1)} / CPU ${context.cpus}`,
    "単独で走らせ直して再現するか確かめること（再現しなければ負荷が原因）",
  ].join(" / ");
}
