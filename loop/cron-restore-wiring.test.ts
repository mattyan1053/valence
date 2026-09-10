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
    //
    // **打つ行を見る**（#679 のレビュー）——**`CronList` の語は、引けるのは
    // セッション自身だけ、と書いた説明にも出てくる**ので、**語だけを見ると、
    // 打つ行を消しても緑のまま**になる（#620 の形）
    expect(restoreSection(role), "予定表を引いていない").toMatch(
      /^1\. \*\*`CronList` を引く\*\*$/m,
    );
  });

  it("空のときだけ入れ直す", () => {
    // **空でないときに足すと、同じ役の予定が 2 つになる**——**周回が 2 倍鳴る**
    const section = restoreSection(role);

    expect(section).toMatch(/^2\. \*\*空のときだけ入れ直す\*\*/m);
    expect(section, "入れ直す手が書かれていない").toMatch(/CronCreate|\/loop /);
  });

  it("引けなかったときは、入れ直さない", () => {
    // **判定不能を「無い」へ倒さない**——**二重登録のほうが害が大きい**
    expect(restoreSection(role), "読めなかったときの向きが無い").toMatch(
      /^3\. \*\*引けなかったときは足さない\*\*/m,
    );
  });

  it("入れ直したことを記録する", () => {
    // **メッセージは揮発する**——**次に読む人が「なぜ刻みが変わったか」を追えない**
    expect(restoreSection(role)).toMatch(/^4\. \*\*入れ直したら残す\*\*/m);
    expect(restoreSection(role)).toContain("bin/loop-cron-restored");
  });

  it("周回が途中で終わる分岐より前にある", () => {
    // **PR が 0 件の周回は、そこでステップを跳ばす**（master のステップ 2）
    // ——**後ろに置くと、いちばん静かな盤面で到達しない**（#679 のレビュー）。
    // **一覧を読めずに終わる経路も同じ**である
    const doc = procedureText(role);
    const section = doc.indexOf("### 自分の予定表を見る");
    const leaves = doc.indexOf("lookup-failed");

    expect(section, "節が無い").toBeGreaterThanOrEqual(0);
    expect(leaves, "途中で終わる経路が見つからない").toBeGreaterThanOrEqual(0);
    expect(section, "先に終わる経路がある").toBeLessThan(leaves);
  });
});
