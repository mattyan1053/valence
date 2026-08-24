/**
 * **起票の前提が「読んだだけ」なのか「確かめた」なのかを、書き分ける**（#481）。
 *
 * **4 回続けて、worker が 1 往復を使って master の前提を覆した**
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

/**
 * 書き分けの箇条書きだけ（`### 「現状はこうなっている」…` から、次の段落まで）。
 *
 * **節ぜんぶで見ると、隣の行に当たる** (#483 のレビュー 2 周目)——**`確かめていない`
 * は 2 行に出る**ので、**芯の 1 行（読んだのか走らせたのか）を消しても、
 * もう 1 行が受けて緑**だった。**`id: evidence` の節を切り出してから
 * `required: true` を見たのと同じ形**にする。
 */
function evidenceRules(): string {
  const step = issueStep();
  const from = step.indexOf("### 「現状はこうなっている」の根拠を、書き分ける");
  expect(from, "書き分けの節がありません").toBeGreaterThanOrEqual(0);
  const rest = step.slice(from);
  const bullets = rest.indexOf("\n- ");
  expect(bullets, "箇条書きがありません").toBeGreaterThanOrEqual(0);
  const to = rest.indexOf("\n\n", bullets);
  return to < 0 ? rest.slice(bullets) : rest.slice(bullets, to);
}

describe("起票の根拠を書き分ける", () => {
  it("手順書が、読んだのか走らせたのかを分けろと言っている", () => {
    // **この Issue の芯**である。**その行にしか無い言い方で見る**
    // ——**`確かめていない` は隣の行にも出る**ので、**そこへ当てると、
    // 芯を消しても緑になる**（#483 のレビュー 2 周目で実際にそうだった）。
    expect(evidenceRules(), "根拠を書けと言っていない").toContain("読んだものか、走らせたものか");
    expect(evidenceRules(), "読んだだけのときの言い方が無い").toContain("「〜のはず」ではなく");
  });

  it("確かめていない前提の上に、完了条件を建てないと書いてある", () => {
    // **害は 1 往復では済まない**——**条件がその前提から建つ**ので、
    // **覆ったときに条件ごと作り直しになる**（#470 は題ごと書き直した）
    expect(evidenceRules(), "完了条件の建て方が書かれていない").toContain("まず確かめる");
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

  it("空欄が何を意味するかが、決めてある", () => {
    // **必須にはしない** (#483 のレビュー)——**この Issue が防ぎたい相手は
    // `gh issue create --body-file` で立てるので、フォームの必須は通らない**うえ、
    // **必須にすると空欄が `n/a` に変わり**、**欲しかった「確かめていない」が消える。**
    //
    // **代わりに、空欄の読み方を決める**——**決めていないと、読む人が
    // 「書き忘れ」と読むか「確かめていない」と読むかで分かれる。**
    const template = read(".github/ISSUE_TEMPLATE/task.yml");

    expect(template, "空欄でよいと書いていない").toContain("確かめていないなら空欄でよい");
    expect(template, "空欄の読み方が決まっていない").toContain("空欄は「確かめていない」と読む");
  });

  it("根拠の欄を必須にしていない", () => {
    // **「入れなかったこと」を試験する** (#483 のレビュー)——**次に読む人が
    // `required: true` を足したくなったとき、ここで赤くなる。**
    const template = read(".github/ISSUE_TEMPLATE/task.yml");
    const evidence = template.slice(template.indexOf("id: evidence"));
    const field = evidence.slice(0, evidence.indexOf("  - type: textarea", 1));

    expect(field, "根拠の欄を必須にしている").not.toContain("required: true");
  });

  it("手順書が、テンプレートの欄を名指ししている", () => {
    // **手順書だけを読む master が、テンプレートの形を知らないまま書かない**
    expect(issueStep(), "テンプレートの欄が手順書に無い").toContain("確かめたこと");
  });
});
