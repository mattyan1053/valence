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
 *
 * **渡している行も、1 本ではない**（#582 のレビュー）。**`acquire` / `recover` は
 * worker に 3 本、master に 2 本ある**ので、**ファイル全体に当てると、どれか 1 本から
 * `unknown` を消しても残りに当たって緑**になる。**倒れる先が悪い**——**`recover` と
 * 読み直しの `acquire` は「印がずれて捨てた周回」の入口**で、**どう始まったかが
 * いちばん分からない場面**である。**そこだけ選択肢が `cron|poke` へ戻る。**
 * **全部取り出して、1 行ずつ見る。**
 *
 * **正本（`bin/loop-lease`）にも同じことが要る**（#582 のレビュー）。
 * **`unknown` はそこに 15 行出る**——**散文だけでなく、`TRIGGER=` の既定値・`case` の
 * 受け口・エラー文にも出る**ので、**`/どちらとも言えない.*unknown/s` は、
 * 守りたい 1 行から `unknown` を消しても後ろに当たって緑**だった
 * （**`/s` で `.` が改行を越える**）。**行に寄せる。**
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

/**
 * 決め方のうち、**守りたい 1 行**を取り出す。
 *
 * **1 行でなければ落とす。** **0 行なら「書いていないから緑」を作る**し、
 * **2 行以上ならどれに当てているか決まらない**（`AGENTS.md` §4）。
 */
function decisionLine(script: string, phrase: string): string {
  const hits = script.split("\n").filter((line) => line.includes(phrase));
  const [only] = hits;
  if (hits.length !== 1 || only === undefined) {
    throw new Error(`決め方の行が ${hits.length} 行あります（1 行のはず）: ${phrase}`);
  }
  return only;
}

/**
 * `--trigger` を**渡している行**を、全部取り出す。
 *
 * **1 本ではない。** **worker は 3 本（`acquire` 2 本と `recover` 1 本）、master は 2 本**
 * ある——**どれも守る対象**なので、**`decisionLine()` のように 1 行へ寄せる形は当たらない。**
 *
 * **0 本なら落とす**（`decisionLine()` と同じ理由）——**打つ行ごと消えたときに
 * 「書いていないから緑」にしない。**
 *
 * **説明の散文と混ざらない。** **散文は `` `--trigger` `` と書く**ので、
 * **`--trigger ` には当たらない**（数えて確かめた）。
 */
function triggerArgumentLines(path: string): string[] {
  const hits = read(path)
    .split("\n")
    .filter((line) => line.includes("bin/loop-lease") && line.includes("--trigger "));
  if (hits.length === 0) {
    throw new Error(`--trigger を渡している行がありません: ${path}`);
  }
  return hits;
}

describe("--trigger の決め方は、1 箇所にある", () => {
  it("判定を持つのは bin/loop-lease である", () => {
    // **手順書ではなく、渡される側が持つ**——**両方の役が同じものを読む唯一の場所**
    const script = read("../bin/loop-lease");

    expect(decisionLine(script, "周回の届き方で決める"), "決め方が書いていない").toContain(
      "時計を見ない",
    );
    expect(decisionLine(script, "どちらとも言えない"), "分からないときの行き先が無い").toContain(
      "unknown",
    );
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

      it.runIf(procedure.acquires)("渡している行すべてに、unknown が並んでいる", () => {
        // **段だけでなく、打つ行にも出ていること**——**読む人が写すのはこちら**。
        // **1 本ではない**ので、**全部取り出して 1 行ずつ見る**（#582 のレビュー）
        for (const line of triggerArgumentLines(procedure.path)) {
          expect(line, "打つ行が古い").toContain("--trigger <cron|poke|unknown>");
        }
      });
    });
  }
});
