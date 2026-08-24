/**
 * **起票の前提が「読んだだけ」なのか「確かめた」なのかを、書き分ける**（#481）。
 *
 * **この窓で 4 回、worker が 1 往復を使って master の前提を覆した**
 * （#456 / #460 / #470 / #478）——**4 回とも、間違えたのは「読んで分かる」と思ったところ**
 * である。
 *
 * **`AGENTS.md` §4 の「書いたら変異させる」は、ここには届かない**——**Issue の本文は
 * 実行されない**ので、**書き分けが在ることを、こちらで見る。**
 *
 * **2 箇所が食い違わないことも見る**——**手順書（master が読む）とテンプレート
 * （人が読む）で、片方だけ直すと、次に書く人がどちらを見るか分からない。**
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/** master の手順のステップ 5（起票）。**節の外に同じ語があっても当たらない。** */
function issueStep(): string {
  const body = read("loop/procedure/master.md");
  const from = body.indexOf("## 5. 作業を割って Issue にする");
  expect(from, "起票のステップがありません").toBeGreaterThanOrEqual(0);
  const rest = body.slice(from);
  const to = rest.indexOf("\n## ", 1);
  return to < 0 ? rest : rest.slice(0, to);
}

describe("起票の根拠を書き分ける", () => {
  it("手順書が、読んだのか走らせたのかを分けろと言っている", () => {
    // **そこにしか無い言い方で見る**（**「確かめる」は節の中に何度も出る**）
    expect(issueStep(), "書き分けの言い方が無い").toContain("確かめていない");
  });

  it("確かめていない前提の上に、完了条件を建てないと書いてある", () => {
    // **害は 1 往復では済まない**——**条件がその前提から建つ**ので、
    // **覆ったときに条件ごと作り直しになる**（#470 は題ごと書き直した）
    expect(issueStep(), "完了条件の建て方が書かれていない").toContain("まず確かめる");
  });

  it("測ることを義務づけていない", () => {
    // **master は判定役で、実装も実行もしない**（#481 の範囲外）
    // ——**「必ず測れ」にすると、測れない起票が全部止まる**
    expect(issueStep(), "測ることを義務づけている").toContain("「起票の前に必ず測れ」ではない");
  });

  it("人が書くテンプレートにも、同じことが書いてある", () => {
    // **片方だけ直すと、次に書く人がどちらを見るか分からない**（#481 の条件）
    const template = read(".github/ISSUE_TEMPLATE/task.yml");

    expect(template, "テンプレートに根拠の欄が無い").toContain("確かめたこと");
    expect(template, "読んだだけのときの書き方が無い").toContain("確かめていない");
  });

  it("手順書が、テンプレートの欄を名指ししている", () => {
    // **手順書だけを読む master が、テンプレートの形を知らないまま書かない**
    expect(issueStep(), "テンプレートの欄が手順書に無い").toContain("確かめたこと");
  });
});
