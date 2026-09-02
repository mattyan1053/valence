/**
 * **どちらで始まったかを、推量ではなく事実から決める**（#581）。
 *
 * **cron はずっと鳴っていた。** **master が時計を見て当て推量していた**ので、
 * **鳴った周回が全部 `poke` として記録されていた**——**7 時間ぶんの
 * 「cron が止まっている」は、全部これ**である（**道具は正しく数えていた。入力が嘘だった**）。
 *
 * **直す先は「ずれ」ではない。** **実測で `7,37` → `:15` / `:45`（+8 分）、
 * `13,43` → `:22` / `:52`（+9 分）**——**作業場が違っても同じ**だが、
 * **当て推量をやめれば、ずれの理由は関係なくなる。**
 *
 * **本当の症状は、決め方が 1 箇所に無かったこと**である——**worker の入口には
 * 根付いていて、master 側には無かった**（**写しですらなく、片方にしか無い**）。
 * **だから片方だけが壊れた。**
 *
 * ## 語では測らない（`AGENTS.md` §4）
 *
 * **`unknown` は `loop/procedure/master.md` に 7 行出る**（`review-budget-unknown` など）
 * ——**本文まるごとに当てると、`--trigger` と関係の無い行で緑になる。**
 * **`--trigger` の段だけを切り出してから見る。**
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** `--trigger` を渡すところ。**3 つとも、同じ 1 箇所を指す。** */
const PROCEDURES = [
  // **`acquire` を打つのは入口だけ**である（**本体は理由を書いている**）
  { name: "worker の入口", path: "../.claude/commands/loop-worker.md", acquires: true },
  { name: "master の入口", path: "../.claude/commands/loop-master.md", acquires: true },
  { name: "master の本体", path: "../loop/procedure/master.md", acquires: false },
] as const;

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

/**
 * `--trigger` の説明の段だけを切り出す。
 *
 * **見つからなければ落とす**——**段ごと消えたときに「書いていないから緑」にしない。**
 */
function triggerParagraph(path: string): string {
  const lines = read(path).split("\n");
  const from = lines.findIndex((line) => line.includes("**`--trigger` は、この周回が"));
  if (from === -1) {
    throw new Error(`--trigger の説明が見つかりません: ${path}`);
  }
  const rest = lines.slice(from);
  const to = rest.findIndex((line, at) => at > 0 && line.trim() === "");
  return (to === -1 ? rest : rest.slice(0, to)).join("\n");
}

describe("--trigger の決め方は、1 箇所にある", () => {
  it("判定を持つのは bin/loop-lease である", () => {
    // **手順書ではなく、渡される側が持つ**——**両方の役が同じものを読む唯一の場所**
    const script = read("../bin/loop-lease");

    expect(script, "決め方が書いていない").toContain("周回の届き方で決める");
    expect(script, "分からないときの行き先が無い").toMatch(/どちらとも言えない.*unknown/s);
  });

  for (const procedure of PROCEDURES) {
    describe(procedure.name, () => {
      it("その 1 箇所を指している", () => {
        expect(triggerParagraph(procedure.path), "指し先が書いていない").toContain(
          "bin/loop-lease",
        );
      });

      it("決め方を書き写していない", () => {
        // **写すと、片方だけが直る**（`AGENTS.md` §5）——**実際そうなっていた**
        expect(triggerParagraph(procedure.path), "決め方を写している").toContain(
          "ここに書き写さない",
        );
      });

      it("分からないときの行き先を言っている", () => {
        // **`poke` へ倒すのが、いちばん静かに壊れる側**である
        expect(triggerParagraph(procedure.path)).toContain("unknown");
      });

      it.runIf(procedure.acquires)("渡せる値に unknown が並んでいる", () => {
        // **段だけでなく、打つ行にも出ていること**——**読む人が写すのはこちら**
        expect(read(procedure.path), "打つ行が古い").toContain("--trigger <cron|poke|unknown>");
      });
    });
  }
});
