/**
 * **届いた配送は、1 通ずつ入口を通す**（#601）。
 *
 * **溜まった `/loop-worker` をまとめて 1 周にすると、2 本目以降は `acquire` を
 * 通らない**——**`cron-blocked` を書くのは `acquire`** なので、**鳴った証拠が
 * 1 行も残らない。**
 *
 * **残らなかったぶんは「間」になる**。**実測: 4 通を 1 周にまとめた作業場で、
 * cron の記録に 8758 秒の「間」が空き**、**`bin/loop-cadence` の窓が
 * 5 周ぶんまで広がった**（**その間、判定は `ok`**）。
 *
 * **入口にしか書けない**——**本体を読むより前に起きる**（入口 1.2）。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ENTRIES = [
  { role: "worker", path: "../.claude/commands/loop-worker.md" },
  { role: "master", path: "../.claude/commands/loop-master.md" },
] as const;

/** その語を持つ行だけ。**本文ではなく、当てたい 1 行を取り出す**（`AGENTS.md` §4）。 */
function linesWith(path: string, phrase: string): string[] {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")
    .split("\n")
    .filter((line) => line.includes(phrase));
}

describe("届いた配送を、1 周にまとめない", () => {
  for (const entry of ENTRIES) {
    it(`${entry.role} の入口が、1 通ずつ通すと言っている`, () => {
      // **選ぶ側も向きを持たせる**（#607 のレビュー 2 周目）——**「1 通ずつ」だけで
      // 選ぶと、「1 通ずつ入口を通さない」に変えてもこの行が選ばれ**、
      // **後段の判定まで通ってしまう。** **片方だけ向きを持っても守れない。**
      const hits = linesWith(entry.path, "1 通ずつ入口を通す");

      expect(hits.length, `言っている行が ${hits.length} 行ある（1 行のはず）`).toBe(1);
      // **語の有無ではなく、向きを見る**（#607 のレビュー）——**`acquire` があること
      // だけを見ると、「`acquire` は打たない」と逆に書いても緑**になる。
      //
      // **散文に当てているので、言い回しを変えると赤くなる。** **それでよい**
      // ——**意味が変わっていないかを、人がそこで見る**（`AGENTS.md` §4）。
      expect(hits[0], "打つ向きを言っていない").toContain(
        "走っていると分かっていても `acquire` を打つ",
      );
    });
  }
});
