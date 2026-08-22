/**
 * **配られた本文が古いとき、人を呼ばずに前へ進めること**（#373）。
 *
 * **入口 1.0 は「印がずれたら捨てて呼び直す（1 回だけ）」**である。
 * **その呼び直しで新しい本文が届く保証は無い**——**実測で 2 回中 1 回**（#94 / #93）。
 * **届かなければ 2 回目も同じ印**で、**`bin/loop-stall procedure-stale` を積んで終わる**
 * ——**そこから先へ進む口が、ループの中に無かった**（**2026-08-22 に worker-2 が踏み、
 * 人間側セッションが外から声を掛けるまで、およそ 2 時間動かなかった**）。
 *
 * **読む先はディスクにある。** **本体は既にそうしている**（#319）ので、
 * **入口も同じ口から読めばよい。**
 *
 * **印の検査は捨てない** (#241 / #243 / #244)。**あれは「古い手順で走り続けるより
 * 止まる」を担っている**——**読み直したあと、その本文の印で `acquire` を打ち直す**
 * ので、**判定はそのまま残る。**
 */

import { describe, expect, it } from "vitest";
import { type LoopRole, procedureText } from "./procedure-doc";

const ROLES: readonly LoopRole[] = ["master", "worker"];

/** 印がずれたときの節。**入口にある**（本体を読む前に走る）。 */
function staleSection(role: LoopRole): string {
  const doc = procedureText(role);
  const from = doc.indexOf("印がずれていたら");
  const to = doc.indexOf("### 1.1");

  expect(from, `${role}: 印がずれたときの節が見つからない`).toBeGreaterThanOrEqual(0);
  expect(to, `${role}: 1.1 が見つからない`).toBeGreaterThan(from);
  return doc.slice(from, to);
}

describe("配られた本文が古いとき", () => {
  it.each(ROLES)("%s は、ディスクから入口を読み直す", (role) => {
    // **呼び直しに頼り切らない**——**届かなければ、そこで手が無くなる**
    expect(staleSection(role), "読み直す口が無い").toContain(
      `bin/loop-procedure-body --entry ${role}`,
    );
  });

  it.each(ROLES)("%s は、読み直してから人を呼ぶ", (role) => {
    // **順番が結果を変える。** **先に `procedure-stale` を積むと、そこで終わる**
    // ——**読み直す行があっても、届かない**
    const section = staleSection(role);
    const read = section.indexOf(`bin/loop-procedure-body --entry ${role}`);
    // **見るのは「通す」と書いてある行**である——**説明として名前を出す行は、
    // 指示ではない**（**名前の出現順で見ると、理由を書き足しただけで赤くなる**）
    const stall = section.indexOf("`bin/loop-stall procedure-stale` を通す");

    expect(stall, "止まる口が消えている").toBeGreaterThanOrEqual(0);
    expect(read, "読み直す前に人を呼んでいる").toBeLessThan(stall);
  });

  it.each(ROLES)("%s は、読み直したあとに印を突き合わせ直す", (role) => {
    // **印の検査を捨てない** (#241 / #243 / #244)。**読み直しただけで進むと、
    // 「古い手順で走り続ける」を自分で作る**——**読んだ本文の印で取り直す。**
    const section = staleSection(role);
    const read = section.indexOf(`bin/loop-procedure-body --entry ${role}`);
    const acquire = section.indexOf(`bin/loop-lease acquire ${role}`, read);

    expect(acquire, "読み直したあと、印を突き合わせ直していない").toBeGreaterThan(read);
  });
});
