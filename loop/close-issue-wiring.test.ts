/**
 * **完了した Issue を閉じる経路が、文面にしか無かった**（#335）。
 *
 * **手順書は「閉じていなければ閉じる」と書いていた**が、**`gh issue close` は
 * リポジトリのどこにも無く**、**何を確かめてから閉じるかも書かれていなかった**
 * ——**実行する側が毎回その場で決めていた。**
 *
 * **ここは「閉じる手が、実行できる形で置いてあるか」を見る。**
 * **倒す向きは「閉じ損ねる」側**である（**残れば誰かが見るが、誤って閉じると作業が消える**）。
 */

import { describe, expect, it } from "vitest";
import { procedureText } from "./procedure-doc";

/** マージの節。**閉じるのはここ**である（ステップ 6 ではない）。 */
function mergeSection(): string {
  const doc = procedureText("master");
  const from = doc.indexOf("### exit 0 — マージする");
  expect(from, "マージの節が無い").toBeGreaterThanOrEqual(0);
  return doc.slice(from).split("\n### ")[0] ?? "";
}

describe("完了した Issue を閉じる", () => {
  it("閉じ忘れを見つける口がある", () => {
    // **`Closes` を書かない PR がある**（割った途中・親として残す）——
    // **#334 のあとは `backlog` へ戻るので `bin/loop-unlisted-issues` も鳴らない**
    expect(mergeSection(), "候補を挙げる口が無い").toContain("bin/loop-close-candidates");
  });

  it("閉じる手が、実行できる形で書いてある", () => {
    // **これが #335 の主題である。** **「閉じる」と書いてあるのに、
    // どう閉じるかがどこにも無かった**
    expect(mergeSection(), "閉じる手が書いていない").toContain("gh issue close");
  });

  it("何を読んでから閉じるかが書いてある", () => {
    // **判定を機械に任せない**（#335 の「やらないこと」）——**読むのは master** である
    expect(mergeSection(), "完了条件を読むと書いていない").toMatch(/完了条件を読/);
  });

  it("満たしていなければ閉じない、と書いてある", () => {
    // **倒す向き。** **割った途中の 1 本で閉じると、残りの作業が消える**
    expect(mergeSection(), "閉じない側の分岐が無い").toMatch(/満たしていなければ閉じない/);
  });

  it("読めなかったときは閉じない、と書いてある", () => {
    // **「候補なし」と「読めない」を混ぜない**——**混ぜると、読めなかった周回が
    // 「閉じるものは無い」になる**
    // **候補を挙げるブロックの直後**（行き先が並ぶところ）を見る——
    // **節のどこかにあれば緑、では別の節の「閉じない」で満たされる**
    const section = mergeSection();
    const from = section.indexOf("bin/loop-close-candidates");
    expect(from, "候補を挙げる口が無い").toBeGreaterThanOrEqual(0);
    const branch = section.slice(from).split("```")[1] ?? "";

    expect(branch, "exit 2 の行き先が無い").toMatch(/exit 2/);
    expect(branch, "読めないときに閉じないと書いていない").toMatch(/読めない。*閉じない/);
  });

  it("`bin/loop-unlisted-issues` を消していない", () => {
    // **別の状態を見ている**（#332 / #335 の「やらないこと」）——
    // **あちらは「どの一覧にも出てこない」、こちらは「属してはいるが終わっている」**
    const doc = procedureText("master");

    expect(doc, "どの一覧にも出てこない Issue の検出が消えている").toContain(
      "bin/loop-unlisted-issues",
    );
  });
});
