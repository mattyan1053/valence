/**
 * **押した結果が、押した人に伝わること**（#315 の完了条件）。
 *
 * **握りつぶさない。** **「押したが何も起きなかった」に見えると、押した人は
 * もう一度押す**——**理由ごとにできることが違う**ので、**文面も分ける。**
 *
 * **GitHub の文面は出さない**（`AGENTS.md` §6）——**出すのは、境界が畳んだ
 * 分類から作った文だけ**である。
 */

import { describe, expect, it } from "vitest";
import type { ApprovalOutcome } from "./approval-notice";
import { approvalNotice, isApprovalOutcome } from "./approval-notice";

const OUTCOMES: readonly ApprovalOutcome[] = [
  "approved",
  "signed-out",
  "needs-login",
  "unavailable",
  "not-found",
  "not-permitted",
  "not-reviewable",
  "gone",
];

describe("Approve の結果を、押した人へ伝える", () => {
  it.each(OUTCOMES)("%s に文面がある", (outcome) => {
    // **黙って終わる結果を作らない**——**どれか 1 つでも空だと、その日は
    // 「押したのに何も起きない」に見える**
    expect(approvalNotice(outcome).length, `${outcome} の文面が無い`).toBeGreaterThan(0);
  });

  it("結果ごとに違う文面である", () => {
    // **1 つにまとめない。** **「できませんでした」だけだと、
    // 入り直せば直るのか、二度と押せないのかが分からない**
    expect(new Set(OUTCOMES.map(approvalNotice)).size).toBe(OUTCOMES.length);
  });

  it("成功と失敗が、文面で見分けられる", () => {
    const approved = approvalNotice("approved");

    for (const outcome of OUTCOMES.filter((each) => each !== "approved")) {
      expect(approvalNotice(outcome), `${outcome} が成功と同じに見える`).not.toBe(approved);
    }
  });

  it("知らない値は、結果として扱わない", () => {
    // **URL から来る**（誰でも書ける）——**検証してから使う**（§6）
    expect(isApprovalOutcome("approved")).toBe(true);
    expect(isApprovalOutcome("こっそり足した文字列")).toBe(false);
    expect(isApprovalOutcome(undefined)).toBe(false);
  });
});
