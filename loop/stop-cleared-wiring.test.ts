/**
 * **止めた理由が消えたことを、止まっている周回が出す**（#634）。
 *
 * **出す先は、周回そのものの応答である。** **止まっている間、繰り返し人の目に入るのは
 * そこだけ**で、**`./task loop:status` は人が引くもの**——**人はそれを定期的には見て
 * いない**（**実測: PR が来てから人が来るまで 10 時間 45 分**）。
 *
 * **散文だけでは足りない**（#313 のレビュー）。**「消えたら言う」と書いても、
 * 入口が口を呼んでいなければ、実行する側に材料が無い**——**ここで見るのは、
 * 入口がその口へ繋がっているか**である。**判定そのものは `bin/loop-stop-cleared` が
 * 持つ**（`AGENTS.md` §5。**振る舞いは `bin/loop-stop-cleared.test.ts`**）。
 *
 * **`loop/STOP` を弱めていないことも、ここで押さえる。** **止まるのは正しい**
 * ——**足りないのは人が来る動機**であって、**止まり方ではない。**
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const ROLES = ["master", "worker"] as const;

/** その役の入口（**cron が運ぶ側**）。 */
function entry(role: (typeof ROLES)[number]): string {
  return readFileSync(join(REPO_ROOT, `.claude/commands/loop-${role}.md`), "utf8");
}

/** 停止条件の節。**節の外の散文で条件が満たされない**ようにする。 */
function stopSection(role: (typeof ROLES)[number]): string {
  const body = entry(role);
  const from = body.indexOf("## 1. 停止条件");
  expect(from, `${role} に停止条件の節が無い`).toBeGreaterThanOrEqual(0);
  return body.slice(from).split("\n### ")[0] ?? "";
}

describe("止まっている周回が、理由の消滅を出す", () => {
  for (const role of ROLES) {
    it(`${role} の入口が、その口を呼んでいる`, () => {
      // **呼んでいなければ、何を書いても実行されない**（#313 と同じ形）
      expect(stopSection(role), "止まっている周回から呼んでいない").toContain(
        "bin/loop-stop-cleared",
      );
    });

    it(`${role} の入口が、3 つの行き先を全部書いている`, () => {
      // **`exit 2` の行き先が無いと、判定できない周回が exit 0 と同じ扱いになる**
      // ——**「消えた」と言っていないのに、言ったことにされる。**
      const section = stopSection(role);
      for (const code of ["exit 0", "exit 1", "exit 2"]) {
        expect(section, `${code} の行き先が書いていない`).toContain(`**${code}**`);
      }
    });

    it(`${role} の入口が、lease を取る前に呼んでいる`, () => {
      // **止まっている周回は lease を取らないと決めてある**（入口 1.0）
      // ——**この口を `acquire` の後ろに置くと、止まっているのに取りに行く。**
      const body = entry(role);
      const cleared = body.indexOf("bin/loop-stop-cleared");
      const acquire = body.indexOf("bin/loop-lease acquire");
      expect(cleared, "呼んでいない").toBeGreaterThanOrEqual(0);
      expect(acquire, "lease を取る行が無い").toBeGreaterThanOrEqual(0);
      expect(cleared, "lease を取ってから呼んでいる").toBeLessThan(acquire);
    });

    it(`${role} の入口が、止まる約束をそのまま残している`, () => {
      // **弱めない。** **足りないのは人が来る動機**であって、**止まり方ではない**
      // ——**この PR が「止まらなくする」方向へ読まれたら、そこで赤くする。**
      expect(stopSection(role), "止まる約束が消えている").toContain("**何もせず直ちに停止する。**");
    });

    it(`${role} の入口が、自分で再開しない`, () => {
      // **`no-work` の 4 回は「人の判断が要る」と決めた結果**である（#634 の
      // 「やらないこと」）——**盤面が動いたからといって、その判断が済んだことに
      // ならない。** **消す口を入口へ書いた時点で、そこが破れる。**
      expect(stopSection(role), "止まっている周回が自分で再開している").not.toContain(
        "loop:resume",
      );
      expect(stopSection(role), "止まっている周回が STOP を消している").not.toMatch(
        /rm .*loop\/STOP/,
      );
    });
  }

  it("判定を、入口へ書き写していない", () => {
    // **どの識別子で鳴るか・何を数えるかは `bin/loop-stop-cleared` が持つ**
    // （`AGENTS.md` §5）——**写すと、片方だけ古くなる。**
    //
    // **`no-work` は理由の説明として出てよい**ので、**数え方のほうを見る**——
    // **入口が口の名前を呼んでいれば、数え方はそちらにしかない。**
    for (const role of ROLES) {
      const section = stopSection(role);
      for (const copied of ["bin/loop-open-work", "bin/loop-in-progress-work", "--label ready"]) {
        expect(section, `${role} の入口が数え方を写している: ${copied}`).not.toContain(copied);
      }
    }
  });
});
