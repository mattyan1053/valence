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
  /**
   * 出したもの（Checks API の `app.id`、Commit Status の `creator.id`）。
   *
   * **名前だけでは「同じ check」と言えない**（#610。**`bin/loop-ci-status` が
   * 同じことを塞いでいる**）——**同名の check を複数の App が出す**ので、
   * **別の App の失敗と一致させると「マージ先でも出ている」が嘘になる。**
   *
   * **番号の名前空間は 2 つある**（App と人）が、**`kind` が分けている**ので混ざらない。
   *
   * **読めないことがある**（`app` も `creator` も応答の側で欠けうる）。
   * **そのときは突き合わせられない**——**`undefined` どうしを一致させない。**
   */
  readonly issuer?: number;
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

/**
 * 突き合わせられる信号か。**発行元が読めないものは比べられない。**
 *
 * **`undefined` どうしを一致させない**——**確かめていないものを「同じ」と言うことになる。**
 */
function comparable(signal: CheckSignal): boolean {
  return signal.issuer !== undefined;
}

function sameSignal(left: CheckSignal, right: CheckSignal): boolean {
  return (
    left.kind === right.kind &&
    left.name === right.name &&
    left.outcome === right.outcome &&
    // **発行元まで見て初めて「同じ check」**である（#610）
    left.issuer === right.issuer
  );
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
  // **1 件でも発行元が読めなければ、そこで止める**——**残りが揃っていても、
  // その 1 件が本物でありうる。** **黙るのも違う**（**黙ると全部が自分のせいに見える**）
  if (!failing.every(comparable)) {
    return "unmeasured";
  }
  // **マージ先の側で発行元が読めない信号は、どれとも一致しない**（`sameSignal`）
  // ——**倒れる先は `only-here`** で、**言い切らない側**である
  return failing.every((signal) => base.failing.some((other) => sameSignal(other, signal)))
    ? "also-on-base"
    : "only-here";
}
