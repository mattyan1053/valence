/**
 * **周回のたびに、自分の予定表を見て、無ければ入れ直すこと**（#677）。
 *
 * **予定表（cron）は 7 日で切れる。** **#670 / #675 が入れたのは「切れたことに
 * 気づく経路」**で、**切れている時間そのものは短くならない**——**気づいてから
 * 誰かが入れ直すまで止まったまま**である。
 *
 * **引けるのはセッション自身だけ**（`CronList` は他のセッションを引けない）なので、
 * **これは手順書にしか書けない**——**スクリプトには落とせない。**
 *
 * **ここで見るのは「訊きに行っているか」と「倒れる向き」**だけである。
 * **記録の形は `bin/loop-cron-restored` が持っている**ので、**手順書へ写さない**
 * （`AGENTS.md` §5）。
 */

import { describe, expect, it } from "vitest";
import { type LoopRole, procedureText } from "./procedure-doc";

/** **予定表を見るところ**。**役ごとに 1 つ**である。 */
function restoreSection(role: LoopRole): string {
  const doc = procedureText(role);
  const section = doc.split("### 自分の予定表を見る")[1] ?? "";
  return section.split("\n### ")[0] ?? "";
}

const ROLES: readonly LoopRole[] = ["master", "worker"];

describe.each(ROLES)("%s の周回は、自分の予定表を見る", (role) => {
  it("引きに行っている", () => {
    // **引けるのはセッション自身だけ**——**他の役からは確かめられない**
    expect(restoreSection(role), "予定表を引いていない").toContain("CronList");
  });

  it("空のときだけ入れ直す", () => {
    // **空でないときに足すと、同じ役の予定が 2 つになる**——**周回が 2 倍鳴る**
    const section = restoreSection(role);

    expect(section).toContain("空のときだけ");
    expect(section, "入れ直す手が書かれていない").toMatch(/CronCreate|\/loop /);
  });

  it("引けなかったときは、入れ直さない", () => {
    // **判定不能を「無い」へ倒さない**——**二重登録のほうが害が大きい**
    expect(restoreSection(role), "読めなかったときの向きが無い").toContain(
      "引けなかったときは足さない",
    );
  });

  it("入れ直したことを記録する", () => {
    // **メッセージは揮発する**——**次に読む人が「なぜ刻みが変わったか」を追えない**
    expect(restoreSection(role)).toContain("bin/loop-cron-restored");
  });
});
