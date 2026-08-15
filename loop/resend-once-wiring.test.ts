/**
 * **出口の 1 通が落ちたら、その周回のうちに 1 回だけ送り直す**（#293）。
 *
 * **セッション間の送信は失敗する。** **2026-08-15 の午後だけで 2 回**
 * （`Failed to send to loop-master.`）——**宛先は `ListAgents` から取ったもので、
 * 名前は合っていた。** **直後に同じ宛先で送り直すと通る**ので、**一時的なもの**である。
 *
 * **記録の側は既に正しい**（#258。**送れたときだけ `--sent` を通す**）ので、
 * **失敗した状態は次の周回でもう一度立ち上がる。** **問題は、その「次の周回」が
 * 30 分後だということ**である——**出口の 1 通は相手を起こすためのもの**なので、
 * **落ちると相手は自分の cron まで動かない。**
 *
 * **手順書は master と worker の両方にある。** **片方だけ直すと食い違う**ので、
 * **両方を同じ走査で見る。**
 *
 * **「送り直す」を数えない。** **出口には前から「同名が複数あるときは `[ref]` を
 * 付けて送り直す」がある**ので、**語だけを探すと、何も足さなくても緑になる**
 * ——**落ちたことに紐づく段落だけを見る。**
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const PROCEDURES = [
  { role: "master", path: ".claude/commands/loop-master.md" },
  { role: "worker", path: ".claude/commands/loop-worker.md" },
] as const;

/** 出口の節。**送る手順が書いてあるのはここだけ**である。 */
function exitSection(path: string): string {
  const doc = readFileSync(join(REPO_ROOT, path), "utf8");
  return doc.split("### 周回の出口")[1]?.split("\n## ")[0] ?? "";
}

/**
 * **落ちたときの送り直しを説明している段落**（空行で区切られた塊）。
 *
 * **`[ref]` の言い換えと混ざらないよう、「落ちた / 失敗した」と同じ塊にあるものだけを取る。**
 */
function resendParagraphs(path: string): string[] {
  return exitSection(path)
    .split(/\n\s*\n/)
    .filter((block) => /送り直/.test(block) && /落ち|失敗/.test(block));
}

describe("落ちたら、その周回のうちに 1 回だけ送り直す", () => {
  it.each(PROCEDURES)("$role の出口に、落ちたら送り直すと書いてある", ({ path }) => {
    // **書いていなければ、落ちた周回はそのまま終わる**——**相手は次の cron まで動かない**
    expect(resendParagraphs(path), "落ちたときに送り直すと書いていない").not.toEqual([]);
  });

  it.each(PROCEDURES)("$role は、送り直す回数を 1 回に限っている", ({ path }) => {
    // **粘ると、そのぶん判定が遅れる**（#293 の「やらないこと」）。
    // **落ち続けるなら、待つより次の周回に任せるほうが安い**
    expect(resendParagraphs(path).join("\n"), "送り直しが 1 回だと読めない").toMatch(/1 回だけ/);
  });

  it.each(PROCEDURES)("$role は、送り直す前に宛先を引き直す", ({ path }) => {
    // **表示名は変わる**（`valence-master-d4` → `loop-master`）。**1 通目と同じ名前を
    // 使い回すと、名前が原因で落ちていた場合に 2 通目も必ず落ちる**
    expect(resendParagraphs(path).join("\n"), "送り直す前に宛先を引き直すと書いていない").toMatch(
      /引き直/,
    );
  });

  it.each(PROCEDURES)("$role は、2 回目も落ちたら --sent を通さない", ({ path }) => {
    // **これまでと変わっていないこと**（#258 が塞いだもの）。**握りつぶして通すと、
    // 届いていない状態が「送信済み」になり、その状態では二度と送られない**
    expect(resendParagraphs(path).join("\n"), "2 回目が落ちたときの行き先が無い").toMatch(/2 回目/);
  });

  it.each(PROCEDURES)("$role は、待ってから送り直すとは書かない", ({ path }) => {
    // **周回の中で粘ると、そのぶん判定が遅れる**（#293 の「やらないこと」）。
    // **打ち消し（「待ってから送り直さない」）と読み違えない**——**未然形は外す**
    expect(exitSection(path), "待ってから送り直すと読める").not.toMatch(
      /待って(から)?送り直[すし]/,
    );
  });
});
