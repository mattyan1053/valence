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
 * `bin/loop-stall.test.ts` の `runNoWorkToLimit` が
 * **固定の git 操作 5 回**（init / add / commit / worktree add / worktree remove）に、
 * **`steps` の件数**（最大 5）を足した回数を起こす。
 *
 * **写した数である。** ここからは `steps` の中身が見えないので、**数え違いは
 * 起こす側で検出する**——`runNoWorkToLimit` は自分が起こした回数を数え、
 * この値を超えたら落ちる。**`steps` を増やしたら、まずそこが赤くなる。**
 * （実際に 1 つ間違えた。9 と数えていて、正しくは 10 だった）
 *
 * **減らせない。** 回数のほとんどは「使い捨ての git リポジトリと worktree を作る」ためで、
 * **`loop/STOP` が両方の worktree へ配られること**を見るのに要る。使い回すと
 * カウンタの状態が試験を跨いで漏れ、**この試験が守っているものが守れなくなる**。
 *
 * **これは「いちばん重い試験」ではなく「既定として面倒を見る回数」である。**
 * 全 scripts 試験を機械的に数える手立ては無い——**helper の中で何個起こすかは
 * ソースの見た目から決まらない**（`bash -c` の中で 16 個起こす試験が実際にあった）。
 *
 * **超えるものは、その試験が自分で枠を宣言する**（`it(name, fn, budgetFor(n))`）。
 * いまの宣言はここに 1 件ある。
 *
 *   bin/loop-lease.test.ts「同時に取りに行っても 1 つしか成功しない」
 *   … `CONCURRENT_ACQUIRES + 1` プロセス（同時に取りに行く数と、束ねる bash が 1 つ）
 *
 * **見つけ方は注記である。** 時間切れの注記が出た試験を数え直して、
 * ここを超えていれば宣言を足す。**全体を上げて合わせない。**
 */
export const MODELLED_SPAWNS = 10;

/**
 * 安全率。**ばらつきが 4.5 倍あるので、最悪値の上にさらに積む。**
 * これを 1 にすると「実測どおりなら間に合う」だけになり、**実測より悪い日に落ちる**。
 */
const MARGIN = 3;

/**
 * プロセスを起こす試験の枠。
 *
 * **伸ばした値ではなく、導いた値である。** vitest の既定 5 秒は
 * **`MODELLED_SPAWNS` 回 × `WORST_SPAWN_MS`** の内側にあり、
 * **間に合わない日があるのが当たり前**だった。
 * 回数か 1 回あたりの費用が変われば、ここも一緒に変わる。
 *
 * **数を書かず、定数の名前で言う。** **写した数は、定数を直した日に置き去りになる**
 * ——**実際に #137 で 9 → 10 を直したとき、この文だけ 9 のまま残った**（#138）。
 */
export const SCRIPT_TEST_TIMEOUT_MS = budgetFor(MODELLED_SPAWNS);

/**
 * 起こす回数から枠を出す。**回数が変われば枠も変わる。**
 *
 * `MODELLED_SPAWNS` を超える試験は、**自分の枠をここから宣言する**
 * （`it(name, fn, budgetFor(n))`）。全体を伸ばして合わせない。
 */
export function budgetFor(spawns: number): number {
  return spawns * WORST_SPAWN_MS * MARGIN;
}

/**
 * hook が起こすプロセスの数（いちばん重い `beforeEach`）。
 *
 * `bin/loop-claim.test.ts` の `beforeEach` が **git 2 回** と、PATH を絞るための
 * **`which` 14 回**を同期実行する。**本体の枠を伸ばしても、hook は別枠**なので、
 * ここを与えないと**本体へ到達する前に落ちる**（既定は 10 秒）。
 *
 * **写した数である。** 数え違いは起こす側で検出する——`bin/loop-claim.test.ts` の
 * `beforeEach` が自分の起こした回数を数え、この値と一致しなければ落ちる。
 */
export const MODELLED_HOOK_SPAWNS = 16;

export type LoadContext = {
  /** 落ちた試験の名前。並んだ出力の中で、どれに付いた注記か分かるようにする。 */
  name: string;
  /**
   * 試験が始まった時刻（epoch ミリ秒）。
   *
   * **`result.duration` は使えない。** `afterEach` の時点では vitest がまだ
   * 記録しておらず、**実測で `undefined`** だった。0 に丸めた結果、
   * **時間切れが「0 ms で失敗」と表示され**、注記のいちばん大事な仕事が失われていた。
   * **取れないこともある**ので、その場合は取れないと言う。
   */
  startedAt: number | undefined;
  /** 落ちたことが分かった時刻（epoch ミリ秒）。 */
  finishedAt: number;
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
  return [
    `[負荷] ${context.name}`,
    howItFailed(context),
    `実行待ち ${context.load1.toFixed(1)} / CPU ${context.cpus}`,
    "単独で走らせ直して再現するか確かめること（再現しなければ負荷が原因）",
  ].join(" / ");
}

function howItFailed(context: LoadContext): string {
  if (context.startedAt === undefined) {
    // **推測で埋めない。** 0 に丸めると「0 ms で失敗」という嘘になる。
    return "かかった時間を取れません";
  }
  const elapsed = context.finishedAt - context.startedAt;
  return elapsed >= context.timeoutMs
    ? `枠 ${context.timeoutMs} ms に届かず時間切れ（${elapsed} ms）`
    : `${elapsed} ms で失敗`;
}
