/**
 * **PR を編集する経路は、必ず取ってから入る**（#203）。
 *
 * **#202 で worker がどこでもブランチを掴まなくなった。** **掴んでいたときは、
 * git の worktree 排他が「同じ PR を 2 人が直す」を偶然に止めていた**——
 * **その錠が外れる。**
 *
 * **入口は 1 つではない。** レビュー対応も、保留を解いた PR の rebase も、
 * **同じ `gh pr checkout --detach` から編集へ入る**——**片方にだけ書くと、
 * もう片方から重複が入る**（`bin/loop-claim` の `resume` を足したのと同じ理由）。
 * **だから場面を並べず、入口を走査する。**
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROCEDURE = ".claude/commands/loop-worker.md";

/** 手順書の bash ブロックを全部取り出す。**書き写さない**（写すと、直さなくても緑になる）。 */
function bashBlocks(): string[] {
  const body = readFileSync(join(REPO_ROOT, PROCEDURE), "utf8");
  return [...body.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
}

/** PR の head へ入るブロック。**ここから先が「編集する」側**である。 */
function checkoutBlocks(): string[] {
  return bashBlocks().filter((block) => block.includes("gh pr checkout --detach"));
}

describe("PR を編集する経路は、取ってから入る", () => {
  it("入口が見つかる", () => {
    // **0 件でも「全部が満たしている」は真になる**——**空振りを緑にしない。**
    // レビュー対応と rebase の 2 つがある
    expect(
      checkoutBlocks().length,
      "PR の head へ入るブロックが見当たらない",
    ).toBeGreaterThanOrEqual(2);
  });

  for (const [index, block] of checkoutBlocks().entries()) {
    it(`${index + 1} つ目の入口は、先に取る`, () => {
      const claimAt = block.indexOf("bin/loop-claim pr");
      const checkoutAt = block.indexOf("gh pr checkout --detach");

      expect(claimAt, "取らずに PR の head へ入っている").toBeGreaterThanOrEqual(0);
      // **順番が要る。** checkout の後で取っても、**もう両方が同じ SHA に居る**
      expect(claimAt, "取る前に checkout している").toBeLessThan(checkoutAt);
    });
  }

  it("取れなかったときの倒れ方が書いてある", () => {
    const body = readFileSync(join(REPO_ROOT, PROCEDURE), "utf8");

    // **黙って飛ばさない。** **待たない**のは lease と同じ判断である
    expect(body, "取れなかったときにどうするか書いていない").toMatch(
      /bin\/loop-claim pr[\s\S]{0,1200}待たない/,
    );
  });
});
