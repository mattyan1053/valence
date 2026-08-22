/**
 * **master のステップ 2 が、持ち手を見てから並べ替えること**（#360）。
 *
 * **出口は「次に動けるのは誰か」を計算している**のに、**次の周回はそれを使わずに
 * 大きさと古さで並べ直していた**——**master が手番を持っている PR が、
 * より小さい / 古い PR に毎周回負ける。** **実測 105 分**（2026-08-22。
 * **worker の読みも出口も正しく、読まなかったのは次の周回のステップ 2**）。
 *
 * **症状は「何も起きていない」**である——**master も worker も正常に周回を終え**、
 * **`bin/loop-stall` にも乗らない**（#347 / #359 と同じ形）。
 *
 * **ここで見るのは「訊きに行っているか」と「その位置」**だけである。
 * **持ち手の判定は `bin/loop-handoff` が持っている**ので、**手順書へ書き写さない**
 * （`AGENTS.md` §5）——**書き写しを試験で縛ると、今度は文言のほうが正になる。**
 */

import { describe, expect, it } from "vitest";
import { procedureText } from "./procedure-doc";

/** **PR を選ぶところ**。**ゲートを回す前**である。 */
function orderingSection(): string {
  const doc = procedureText("master");
  const section = doc.split("**複数あるときは順番が結果を変える。**")[1] ?? "";
  return section.split("\n## ")[0] ?? "";
}

describe("持ち手を見てから並べ替える", () => {
  it("誰の番かを、読むだけの口で訊く", () => {
    // **ふつうに打つと、自分の番では黙る**（#92 の自己通知の抑止）——
    // **並べ替えに使うなら `--who` である**
    expect(orderingSection()).toContain("bin/loop-handoff master --who");
  });

  it("訊くのは、依存とコンフリクトを見るより前である", () => {
    // **依存も大きさも古さも「どれから片付けると詰まりが早く解けるか」**の順序で、
    // **どれも「master が動ける」ことを前提にしている。** **持ち手はその前提そのもの**
    // ——**前提を後ろに置くと、動ける PR が毎周回負ける**（上限が無い）。
    const section = orderingSection();
    const asked = section.indexOf("bin/loop-handoff master --who");
    const dependency = section.indexOf("他の PR が依存しているもの");

    expect(asked, "訊いていない").toBeGreaterThanOrEqual(0);
    expect(dependency, "並べ替えの一覧が無い").toBeGreaterThanOrEqual(0);
    expect(asked, "依存を見たあとに訊いている").toBeLessThan(dependency);
  });

  it("持ち手が同じなら、これまでどおりの順序である", () => {
    // **退行の検出。** **前に足したぶんで、後ろの規則が消えていないこと**
    const section = orderingSection();
    const order = [
      "他の PR が依存しているもの",
      "コンフリクトしていないもの",
      "小さいもの",
      "古いもの",
    ];

    let previous = -1;
    for (const item of order) {
      const at = section.indexOf(item);
      expect(at, `${item} が並べ替えから消えている`).toBeGreaterThanOrEqual(0);
      expect(at, `${item} の順序が入れ替わっている`).toBeGreaterThan(previous);
      previous = at;
    }
  });
});
