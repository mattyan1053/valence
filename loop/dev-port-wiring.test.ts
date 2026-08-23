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

/** 手引きの ```bash ブロック（**コメントごと**）。 */
function blocks(): string[] {
  const text = readFileSync(SKILL, "utf8");
  return [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
}

/** そのブロックで**実際に打つ行**（コメントと空行は除く）。 */
function lines(block: string): string[] {
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/**
 * そのブロックを**どの機械で打つか**。**1 行目の名指しで決める。**
 *
 * **本文のどこかに在るか、では決めない**——**理由の説明でもう一方の機械に触れる**
 * ので、**両方に当たって「決まらない」になる。**
 */
function machineOf(block: string): "local" | "workspace" | undefined {
  const first = block.split("\n").find((line) => line.trim().startsWith("#")) ?? "";
  if (first.includes("手元")) {
    return "local";
  }
  return first.includes("作業場のある機械") ? "workspace" : undefined;
}

/** 手引きのうち、**実際に打つ行**（コメントと空行は除く）。 */
function commands(): string[] {
  return blocks()
    .flatMap((block) => block.split("\n"))
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

  it("ポートを訊くのは、作業場のある機械である", () => {
    // **`./task port` は、打った機械の `basename $PWD` から決まる** (#416 のレビュー)
    // ——**手元（ブラウザのある側）で打つと、手元のディレクトリ名の port が出る。**
    //
    // **落ちるより、通るほうが悪い。** **`valence` という名前の clone が手元にあれば、
    // 転送は通り、画面も開く**——**開いたのは別の作業場のアプリ**で、
    // **この Issue が消しに来たのが、まさにその形**である。
    //
    // **行ではなく、ブロックで見る** (この試験を最初に行で書いて、変異を素通しした)
    // ——**同じ行が両方のブロックに在りうる**ので、**「どこかのブロックに在る」では
    // 「このブロックで打ってよい」を言えない。**
    for (const block of blocks()) {
      if (!block.includes("./task port") || machineOf(block) !== "local") {
        continue;
      }
      const asked = lines(block).filter((line) => line.includes("./task port"));
      for (const line of asked) {
        expect(line, `手元で作業場のポートを訊いている: ${line}`).toMatch(/\bssh\s/);
      }
    }
  });

  it("転送する port を書き写していない", () => {
    // **訊いた値をそのまま渡す**——**書き写すと、作業場が変わった日に黙って別の側へ繋ぐ**
    const forwarding = commands().filter((line) => line.includes("ssh -L"));

    expect(forwarding.length, "転送の例が無い").toBeGreaterThan(0);
    for (const line of forwarding) {
      expect(line, "転送する port を、書き写している").toMatch(/\$\{?port\b/);
    }
  });

  it("どちらの機械で打つかが、ブロックに書いてある", () => {
    // **混ざると、また間違った側で訊く**——**port を触るブロックは、必ず名指しする。**
    const touching = blocks().filter((block) => block.includes("./task port"));

    expect(touching.length, "port を訊くブロックが無い").toBeGreaterThan(0);
    for (const block of touching) {
      expect(
        machineOf(block),
        `どちらの機械で打つのかが、1 行目に無い: ${block.slice(0, 60)}`,
      ).toBeDefined();
    }
  });

  it("自分の作業場のものかを確かめる手がある", () => {
    // **間違えてもエラーにならない**ので、**確かめる手が要る**——
    // **その port を publish しているコンテナの名前を見る。**
    const text = readFileSync(SKILL, "utf8");

    expect(text, "自分のものか確かめる手が無い").toMatch(/docker ps[\s\S]*publish=/);
  });
});
