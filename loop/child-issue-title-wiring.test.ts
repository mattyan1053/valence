import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/**
 * **親子をタイトルの末尾で突き合わせるなら、そう書く側も知っていること**（#544）。
 *
 * **`bin/loop-claim idle` が親まで辿れるのは、子 Issue のタイトルの末尾だけ**である
 * ——**枝が名乗るのは子の番号**なので、**末尾が無い子 Issue を立てられた時点で、
 * 親は必ず「止まっている」に倒れる。**
 *
 * **読む側の試験は `bin/loop-claim.test.ts` にある。** **ここが見るのは、
 * 書く側がそれを知っているか**である——**規則にした以上、書く側も直っていないと、
 * 直したはずの誤報がそのまま戻る。**
 *
 * **判定は行に寄せる。** **文書全体に `末尾` を当てると、番号や順序の話をしている
 * 別の行で緑になる**（`AGENTS.md` §4）。
 */
describe("子 Issue のタイトルの末尾", () => {
  /** その語を含む行。**1 行に定まらなければ、この試験は何を見ているか分からない。** */
  function lineWith(text: string, phrase: string): string {
    const found = text.split("\n").filter((line) => line.includes(phrase));
    expect(found, `「${phrase}」を含む行が 1 つに定まらない`).toHaveLength(1);
    return found[0] ?? "";
  }

  it("起票する側の手順に、末尾に置くと書いてある", () => {
    const master = read("loop/procedure/master.md");

    expect(lineWith(master, "（#<親の番号>）"), "末尾だと言っていない").toContain("末尾");
    // **位置を言わないと、途中に書いた番号まで数える実装へ戻せてしまう**
    expect(master, "途中の番号を数えないことを言っていない").toContain("途中に書いても数えない");
  });

  it("枝の名前の規約にも、同じことが書いてある", () => {
    // **「枝が名乗るのは子の番号」を言っているのはこちら**——**枝の命名の隣に無いと、
    // 割るときに読む文書と、名前を付けるときに読む文書が分かれる。**
    expect(
      lineWith(read(".claude/rules/git-workflow.md"), "（#<親の番号>）"),
      "末尾だと言っていない",
    ).toContain("末尾");
  });

  it("読む側は、末尾だけを見る", () => {
    // **書いてある位置と、実際に見ている位置がずれていないこと**
    // ——**錨（`$`）が外れると、引き合いに出しただけの番号まで親子になる**（#322）。
    expect(read("bin/loop-claim"), "末尾に錨を置いていない").toContain("（#([0-9]+)）$");
  });
});
