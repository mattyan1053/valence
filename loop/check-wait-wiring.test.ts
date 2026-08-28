import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/**
 * **切られたら、打ち直す前に付き直す**（#552）。
 *
 * **単独の `./task check` が外側の 10 分に届くようになった**（**実測 670 / 698 秒**）
 * ——**切られてもコンテナの中は走り続ける**（#528）ので、**打ち直すと同じものを
 * 2 度走らせる**（**1 周ぶん余計**）。
 *
 * **口を作っても、手順書が打たなければ何も変わらない**——**そこを繋いで見る。**
 */
describe("切られた check に付き直す", () => {
  /** その語を含む行。**1 行に定まらなければ、何を見ているか分からない。** */
  function lineWith(text: string, phrase: string): string {
    const found = text.split("\n").filter((line) => line.includes(phrase));
    expect(found, `「${phrase}」を含む行が 1 つに定まらない`).toHaveLength(1);
    return found[0] ?? "";
  }

  it("手順書が、分からないときに付き直す", () => {
    // **打ち直すのは、付き直して「走っていない」と分かってから**である
    const body = read("loop/procedure/worker.md");

    expect(lineWith(body, "./task check:wait"), "合否を受けていない").toContain("status=$?");
    expect(body, "打ち直す前に付き直すと言っていない").toContain("打ち直す前に付き直す");
  });

  it("口がある", () => {
    // **手順書だけが知っていても打てない**
    expect(read("task"), "単独で打てない").toContain("cmd_check_wait()");
  });

  it("判定は 1 箇所が持つ", () => {
    // **`--await` は `--verdict` を呼ぶ**（`AGENTS.md` §5）——**合否の読み方を
    // 2 通り持たない。** **写すと、片方だけ直したときに食い違う。**
    const script = read("bin/loop-check-state");
    const awaiting = script.slice(script.indexOf("  --await)")).split("\n    ;;\n")[0] ?? "";

    expect(awaiting, "自前で合否を読んでいる").toContain('"$0" --verdict');
  });

  it("待つのは、走っているあいだだけ", () => {
    // **「走っていない」で回り続けない**——**`3` 以外はそのまま返す**
    const script = read("bin/loop-check-state");
    const awaiting = script.slice(script.indexOf("  --await)")).split("\n    ;;\n")[0] ?? "";

    expect(awaiting, "走っている以外でも待ち続ける").toContain(
      '((verdict == 3)) || exit "$verdict"',
    );
  });
});
