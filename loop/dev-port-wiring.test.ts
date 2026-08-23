/**
 * **開発の手引きが、作業場ごとの port を知らない**（#412）。
 *
 * **`.claude/skills/dev-environment/` は `127.0.0.1:3000` で書かれていた**が、
 * **worker の作業場は別の port で上がる**（`./task` が決める。#82）——
 * **手引きどおりに転送すると、別の作業場のアプリが普通に開く。**
 * **エラーにならない**ので、**見ているものが自分のものだと思い込んだまま進む。**
 *
 * **書き写さない**（#377 / #400 と同じ向き）——**決めているのは `./task`** なので、
 * **手引きはそこへ訊く形で書く。**
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILL = join(REPO_ROOT, ".claude/skills/dev-environment/SKILL.md");

/** 手引きのうち、**実際に打つ行**（```bash ブロックの中身）。 */
function commands(): string[] {
  const text = readFileSync(SKILL, "utf8");
  return [...text.matchAll(/```bash\n([\s\S]*?)```/g)]
    .flatMap((match) => (match[1] ?? "").split("\n"))
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

describe("開発の手引きは、作業場ごとの port を訊く", () => {
  it("訊く口を使っている", () => {
    expect(readFileSync(SKILL, "utf8"), "手引きが `./task port` を知らない").toContain(
      "./task port",
    );
  });

  it("番号を書き写していない", () => {
    // **打つ行に生の 3000 が残っていると、そこだけ既定の作業場を指す**
    // ——**説明の中の 3000（コンテナの中の port）は別**なので、打つ行だけを見る。
    //
    // **`:3000` を除かない** (この試験を最初にそう書いて、変異を素通しした)
    // ——**`ss -tlnp | grep :3000` も `ssh -L 3000:localhost:3000` も、
    // まさに直したかった形**である。**打つ行に 3000 は要らない。**
    const written = commands().filter((line) => line.includes("3000"));

    expect(written, `手引きが port を書き写している: ${written.join(" / ")}`).toEqual([]);
  });

  it("自分の作業場のものかを確かめる手がある", () => {
    // **間違えてもエラーにならない**ので、**確かめる手が要る**——
    // **その port を publish しているコンテナの名前を見る。**
    const text = readFileSync(SKILL, "utf8");

    expect(text, "自分のものか確かめる手が無い").toMatch(/docker ps[\s\S]*publish=/);
  });
});
