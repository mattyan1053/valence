import { describe, expect, it } from "vitest";
import type { BaseCi, CheckSignal } from "./ci-attribution";
import { ciFailureScopeOf } from "./ci-attribution";

const TEST_RUN: CheckSignal = { kind: "check-run", name: "test", outcome: "failure", appId: 15368 };
const TYPECHECK_RUN: CheckSignal = {
  kind: "check-run",
  name: "typecheck",
  outcome: "failure",
  appId: 15368,
};

/** マージ先の CI。**既定は「終わっている」**——突き合わせられる状態である。 */
function base(failing: readonly CheckSignal[], settled = true): BaseCi {
  return { settled, failing };
}

describe("ciFailureScopeOf", () => {
  it("落ちている check が無ければ、言うことは無い", () => {
    // **CI が通っている PR に、突き合わせの話を出さない**
    expect(ciFailureScopeOf([], base([TEST_RUN]))).toBeUndefined();
  });

  it("マージ先を読めなければ、突き合わせられないと言う", () => {
    // **「マージ先は緑」へ倒さない**——**倒すと、全部が自分のせいに見える**
    expect(ciFailureScopeOf([TEST_RUN], undefined)).toBe("unmeasured");
  });

  it("マージ先の CI が終わっていなければ、突き合わせられないと言う", () => {
    // **走っている最中は「落ちていない」ではなく「まだ分からない」**である
    expect(ciFailureScopeOf([TEST_RUN], base([], false))).toBe("unmeasured");
  });

  it("マージ先でも同じ check が同じように落ちていれば、そう言う", () => {
    expect(ciFailureScopeOf([TEST_RUN], base([TEST_RUN, TYPECHECK_RUN]))).toBe("also-on-base");
  });

  it("マージ先が通っていれば、この PR にしか出ていないと言う", () => {
    expect(ciFailureScopeOf([TEST_RUN], base([]))).toBe("only-here");
  });

  it("落ち方が違えば、この PR にしか出ていないと言う", () => {
    // **「同じように落ちている」まで見る**——**別の理由で落ちているのを
    // 「マージ先のせい」にすると、本物を見落とす**
    expect(ciFailureScopeOf([TEST_RUN], base([{ ...TEST_RUN, outcome: "timed_out" }]))).toBe(
      "only-here",
    );
  });

  it("名前が同じでも、発行元が違えば別の check として見る", () => {
    // **同名の check を複数の App が出す**（#610。**`bin/loop-ci-status` が
    // 同じ穴を塞いでいる**）——**別の App の失敗と一致させると、
    // 「マージ先でも出ている」が嘘になる。**
    expect(ciFailureScopeOf([TEST_RUN], base([{ ...TEST_RUN, appId: 57789 }]))).toBe("only-here");
  });

  it("Commit Status には発行元が無いので、そこは名前と落ち方で見る", () => {
    // **`kind` で名前空間が分かれている**ので、**片方に無い項目で弾かない**
    const status: CheckSignal = { kind: "commit-status", name: "ci/travis", outcome: "failure" };

    expect(ciFailureScopeOf([status], base([{ ...status }]))).toBe("also-on-base");
  });

  it("名前が同じでも、種類が違えば別の check として見る", () => {
    // **Checks API と Commit Status は別の名前空間**である。
    // **同じ語だからと繋ぐと、無関係な失敗を「マージ先のせい」にする**
    expect(ciFailureScopeOf([TEST_RUN], base([{ ...TEST_RUN, kind: "commit-status" }]))).toBe(
      "only-here",
    );
  });

  it("1 つでもマージ先に無い失敗があれば、この PR にしか出ていないと言う", () => {
    // **言い切るのは全部が一致したときだけ**——**残り 1 件が本物でありうる**
    expect(ciFailureScopeOf([TEST_RUN, TYPECHECK_RUN], base([TEST_RUN]))).toBe("only-here");
  });
});
