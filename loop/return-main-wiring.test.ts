/**
 * **枝の上で周回を終えない**（#405）。
 *
 * **1.1 は「いまの HEAD」と「`origin/main`」を比べる**ので、**枝に居たまま終えると、
 * 枝分かれの跡から `main` に入ったぶんが毎回差分に出る**——**`before` が動かない**ので、
 * **その枝で作業を続ける限り、毎周回捨てられる**（実測: 2026-08-23、2 周続けて）。
 *
 * **規則を散文に書くだけにしない**（#176 の「錠を作って、掛けていない」）——
 * **打つ場所にあるかを見る。**
 */

import { describe, expect, it } from "vitest";
import { type LoopRole, procedureText } from "./procedure-doc";

const ROLES: LoopRole[] = ["master", "worker"];

/** 出口の節（`### 周回の出口` から、次の `## ` まで）。 */
function exitSection(role: LoopRole): string {
  const text = procedureText(role);
  const from = text.indexOf("### 周回の出口");
  expect(from, `${role} の手順書に出口の節が無い`).toBeGreaterThanOrEqual(0);
  return text.slice(from).split("\n## ")[0] ?? "";
}

/** 出口で実際に打つ行（bash ブロックの中身。**コメント行は落とす**）。 */
function executedLines(role: LoopRole): string[] {
  return [...exitSection(role).matchAll(/```bash\n([\s\S]*?)```/g)]
    .flatMap((match) => (match[1] ?? "").split("\n"))
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

describe.each(ROLES)("%s の出口が、木を戻す", (role) => {
  it("戻す口を打っている", () => {
    // **散文ではなく、打つ行を見る**——**説明に書いた語で満たさない**
    const lines = executedLines(role);

    expect(
      lines.some((line) => line.startsWith("bin/loop-return-main")),
      "出口で木を戻していない",
    ).toBe(true);
  });

  it("lease を返すより前に打つ", () => {
    // **返したあとに木を動かすと、次の周回の足元から抜く**（#68 の形）——
    // **握っている間に戻す。**
    const lines = executedLines(role);
    const returns = lines.findIndex((line) => line.startsWith("bin/loop-return-main"));
    const releases = lines.findIndex((line) => line.startsWith(`bin/loop-lease release ${role}`));

    expect(returns, "戻す口が無い").toBeGreaterThanOrEqual(0);
    expect(releases, "返す行が無い").toBeGreaterThanOrEqual(0);
    expect(returns, "返したあとに木を動かしている").toBeLessThan(releases);
  });

  it("戻れたら、カウンタを消す", () => {
    // **消さないと、散発的な失敗が何周うまくいっても足し算される** (#406 のレビュー)
    // ——**3 周続いた扱いで全ループが止まる。** **`main-sync-failed` と同じ形**で、
    // **前へ進んだ証拠は「戻れたこと」**である（#266）。
    expect(exitSection(role), "戻れた周回が、カウンタを消していない").toContain(
      "bin/loop-stall --reset return-main-failed",
    );
  });

  it("戻せなかったときの行き先が書いてある", () => {
    // **戻せない理由は実在する**（**commit していない変更、切り替えの失敗**）——
    // **黙って進まない**（#405 の完了条件）。**識別子は `bin/loop-stall` が持つ。**
    expect(exitSection(role), "戻せなかったときに、数える口が無い").toContain(
      "bin/loop-stall return-main-failed",
    );
  });
});
