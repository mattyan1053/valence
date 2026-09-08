/**
 * 落ちている CI が、この PR にしか出ていないのか、マージ先でも同じように出ているのか。
 *
 * **マージ先が赤いと、その上の PR は全部赤くなる**（#638）。**盤面が
 * 「CI: 落ちています」としか言わないと、自分のせいでない失敗を全員が追いかける。**
 *
 * **言い切るのは、同じ check が同じように落ちているときだけ**である
 * ——**別の理由で落ちているものを「マージ先でも出ている」と言うと、本物を見落とす。**
 *
 * **突き合わせられないときは、そう言う**（`AGENTS.md` §5）。**「マージ先は緑」へ
 * 倒さない**——**倒すと、全部が自分のせいに見える**（いまの画面がそうなっている）。
 *
 * **ここは純粋関数**である。どの commit と突き合わせたかは infrastructure が決める。
 */

/** どちらの仕組みが出した信号か。**同じ語でも、名前空間が違えば別の check である。** */
export type CheckSignalKind = "check-run" | "commit-status";

/** 落ちている check の 1 件。 */
export type CheckSignal = {
  readonly kind: CheckSignalKind;
  /** Checks API の `name`、Commit Status の `context`。 */
  readonly name: string;
  /**
   * どう落ちたか（`failure` / `timed_out` / `error` など）。
   *
   * **「落ちた」で束ねない。** **同じ check が同じように落ちているか**を見るので、
   * **落ち方まで一致して初めて「マージ先でも出ている」と言える。**
   */
  readonly outcome: string;
};

/** 突き合わせる先（マージ先ブランチの先端）で見えた CI。 */
export type BaseCi = {
  /**
   * **CI が終わっているか。**
   *
   * **走っている最中は「落ちていない」ではなく「まだ分からない」**である。
   * **終わっていないものを緑と読むと、そのぶんが全部この PR のせいに見える。**
   */
  readonly settled: boolean;
  /** マージ先で落ちている check。**終わっていれば、これが全部である。** */
  readonly failing: readonly CheckSignal[];
};

export type CiFailureScope =
  /** **マージ先でも、同じ check が同じように落ちている。** */
  | "also-on-base"
  /** **マージ先には出ていない失敗がある。** */
  | "only-here"
  /** **突き合わせられなかった。** */
  | "unmeasured";

function sameSignal(left: CheckSignal, right: CheckSignal): boolean {
  return left.kind === right.kind && left.name === right.name && left.outcome === right.outcome;
}

/**
 * 落ちている CI の出どころを見る。**落ちていなければ `undefined`**（言うことが無い）。
 *
 * **全部が一致したときだけ「マージ先でも出ている」と言う。** 1 件でもマージ先に無ければ、
 * **その 1 件が本物でありうる**ので、この PR の側へ倒す。
 */
export function ciFailureScopeOf(
  failing: readonly CheckSignal[],
  base: BaseCi | undefined,
): CiFailureScope | undefined {
  if (failing.length === 0) {
    return undefined;
  }
  if (base === undefined || !base.settled) {
    return "unmeasured";
  }
  return failing.every((signal) => base.failing.some((other) => sameSignal(other, signal)))
    ? "also-on-base"
    : "only-here";
}
