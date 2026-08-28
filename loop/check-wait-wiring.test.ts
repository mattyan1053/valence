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

  it("書いた側が居なければ、待つのをやめる", () => {
    // **`finished` を書けるのは、その走りの側だけ** (#555 のレビュー)
    // ——**居なければ待っても来ない。** **上限を秒で置かない**
    // （**時間を判定に使わない**。#131 / #552）。
    const script = read("bin/loop-check-state");
    const awaiting = script.slice(script.indexOf("  --await)")).split("\n    ;;\n")[0] ?? "";

    expect(awaiting, "書き手が居るかを見ていない").toContain("writer_alive && alive=1");
    expect(awaiting, "書き手が居ないときに待つのをやめていない").toContain(
      "((alive == 1)) || exit 5",
    );
    expect(awaiting, "時間で打ち切っている").not.toMatch(/SECONDS|date \+%s/);
  });

  it("「来ない」を合否に化けさせない", () => {
    // **`5` は赤ではない**——**打ち直す先が違う**
    const runner = read("task");
    const waiting = runner.slice(runner.indexOf("cmd_check_wait() {")).split("\n}\n")[0] ?? "";

    // **どの終了コードで言うか**まで見る——**文面だけだと、繋ぎ先を変えても緑になる**
    expect(waiting, "5 で受けていない").toMatch(/\n {4}5\)\n/);
    expect(waiting, "来ないことを言っていない").toContain("書いた側が居ません");
    expect(waiting, "残りを見ろと言っていない").toContain("check:leftovers");
  });

  it("手順書が、打ち直す先を分けている", () => {
    // **`4`（走っていない）と `5`（来ない）で、次にすることは同じでも理由が違う**
    const body = read("loop/procedure/worker.md");

    expect(body, "5 の意味を言っていない").toContain("`5` は「記録は残っているが");
  });

  it("書き手を、合否より先に見る", () => {
    // **順序でしか閉じない窓である** (#555 のレビュー 2 周目)。**先に合否を見ると、
    // 「まだ走っている」と読んだ直後に書き手が終わって消え**、**合否が出ているのに
    // 「打ち直せ」と言う**——**いちばん拾いたい「ちょうど終わった」回**である。
    //
    // **静止した状態では、順序は見えない**（**どちらの順でも同じ答えになる**）
    // ——**入れ違いは、実物を競らせないと起きない。** **だから並びで見る。**
    const script = read("bin/loop-check-state");
    const awaiting = script.slice(script.indexOf("  --await)")).split("\n    ;;\n")[0] ?? "";
    const looked = awaiting.indexOf("writer_alive && alive=1");
    const judged = awaiting.indexOf('"$0" --verdict');

    expect(looked, "書き手を見ていない").toBeGreaterThanOrEqual(0);
    expect(judged, "合否を見ていない").toBeGreaterThanOrEqual(0);
    expect(looked, "合否を先に見ている（窓が開く）").toBeLessThan(judged);
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
