/**
 * **残骸の報せが、読み手に届くか**（#529 のレビュー 3 周目）。
 *
 * **判定が正しいことと、判定の結果が届くことは別**である。
 *
 * **`./task check` は、手順書の受け方だと丸ごと `$log` へ入る**——
 * **緑なら `cat` されずに消える。** **`./task check` の中で `[WARN]` を出しても、
 * 狙っている worker の経路では一度も見えない**（**しかも「切られた」場面では
 * 呼び出し側が死ぬので、あとから log を出す処理にも到達しない**）。
 *
 * **打つところは 1 つとは限らない** (#166 / #168 の形)——**全部並べて見る。**
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { procedureText } from "./procedure-doc";

/** 手順書の bash ブロック。 */
function blocks(): string[] {
  const found: string[] = [];
  let body: string[] | undefined;
  for (const line of procedureText("worker").split("\n")) {
    if (line.startsWith("```")) {
      if (body !== undefined) {
        found.push(body.join("\n"));
      }
      body = line.startsWith("```bash") ? [] : undefined;
      continue;
    }
    body?.push(line);
  }
  return found;
}

/** **`./task check` を打つブロックを、全部並べる。** **1 つだけ見ない。** */
function checkBlocks(): string[] {
  return blocks().filter((body) => body.includes('./task check >"$log"'));
}

describe("残骸の報せが、手順書の受け方でも届く", () => {
  const sandboxes: string[] = [];

  afterEach(() => {
    for (const dir of sandboxes.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("`./task check` を打つところは、1 つではない", () => {
    // **この試験自身が、名指しになっていないこと**（**増えたら増えたぶんを見る**）
    expect(checkBlocks().length, "打つところが見つからない").toBeGreaterThan(1);
  });

  it("どのブロックも、打つ前に残骸を見る", () => {
    for (const body of checkBlocks()) {
      const looked = body.indexOf("./task check:leftovers");
      const ran = body.indexOf('./task check >"$log"');

      expect(looked, `残骸を見ていないブロックがある:\n${body}`).toBeGreaterThanOrEqual(0);
      expect(looked, `打ってから見ている:\n${body}`).toBeLessThan(ran);
    }
  });

  it("見るところが、リダイレクトの外にある", () => {
    // **これが本題である。** **`>"$log"` の付いた行の中で呼ぶと、緑のとき消える。**
    for (const body of checkBlocks()) {
      const line = body.split("\n").find((row) => row.includes("./task check:leftovers")) ?? "";

      expect(line, `報せが log へ入っている:\n${line}`).not.toContain(">");
    }
  });

  /**
   * **手順書の受け方を、そのまま入力に置く**（#529 のレビュー）。
   *
   * **「リダイレクトして、緑なら消す」に食わせて、報せが端末に残るか**を見る
   * ——**構造だけを見ると、書き方を変えたときに気づけない。**
   */
  function runRecipe(recipe: string): string {
    const dir = mkdtempSync(join(tmpdir(), "leftovers-recipe-"));
    sandboxes.push(dir);
    mkdirSync(join(dir, "bin"));
    writeFileSync(
      join(dir, "task"),
      [
        "#!/usr/bin/env bash",
        'if [[ $1 == "check:leftovers" ]]; then',
        '  echo "[WARN] この作業場に、前の走りが残っています" >&2',
        "  exit 1",
        "fi",
        'if [[ $1 == "check" ]]; then',
        '  echo "走った"',
        '  echo "check-exit=0"',
        "  exit 0",
        "fi",
        "exit 2",
      ].join("\n"),
      { mode: 0o755 },
    );
    // **止まる口は、この試験の対象ではない**——**呼ばれても何もしない**
    writeFileSync(join(dir, "bin", "loop-stall"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    const done = spawnSync("bash", ["-c", recipe], { cwd: dir, encoding: "utf8" });
    return `${done.stdout}${done.stderr}`;
  }

  /** ブロックのうち、**受け方の部分だけ**を切り出す（`log=` から `rm -f` まで）。 */
  function redirectPart(body: string): string {
    const lines = body.split("\n");
    const from = lines.findIndex((line) => line.includes("./task check:leftovers"));
    const to = lines.findIndex((line) => line.startsWith('rm -f "$log"'));
    expect(from, "見るところが無い").toBeGreaterThanOrEqual(0);
    expect(to, "log を消すところが無い").toBeGreaterThan(from);
    return lines
      .slice(from, to + 1)
      .join("\n")
      .replace(/<Issue番号>/g, "999");
  }

  it("緑でも、報せは端末に残る", () => {
    const shown = runRecipe(redirectPart(checkBlocks()[0] ?? ""));

    expect(shown, "報せが log へ入って消えている").toContain("前の走りが残っています");
    // **check の出力は、これまでどおり緑なら出ない**（**受け方は変えていない**）
    expect(shown, "check の出力まで出ている").not.toContain("走った");
  });

  it("見るところを外すと、届かなくなる", () => {
    // **この試験が何を測っているか**——**外した形を食わせて、赤くなることを見る**
    const withoutLook = redirectPart(checkBlocks()[0] ?? "")
      .split("\n")
      .filter((line) => !line.includes("./task check:leftovers"))
      .join("\n");

    expect(runRecipe(withoutLook), "外したのに届いている").not.toContain("前の走りが残っています");
  });
});
