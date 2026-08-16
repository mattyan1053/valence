/**
 * **lease を返す位置が、返す場所に書いてあること**（#340）。
 *
 * **2 セッションで 2 回踏んだ**——**出口を打つコマンドに `bin/loop-lease release` を
 * 混ぜ、送信より先に返した。** **返したあとに cron の周回が入ると、同じ判定を
 * もう一度立てる**（**指紋は `--sent` を通すまで動かない**）し、**`--sent` を打つのは
 * lease を持たない周回**になる（`bin/loop-lease check` が「入口を飛ばした」を記録する側）。
 *
 * **規則はあった。実行される場所に無かった**——**#176 の「錠を作って、掛けていない」**の
 * 裏返しである。**#319 で入口と本体を分けたとき、出口は本体へ移り、返す規則は入口に
 * 残った**（**入口を短くするほど両端が離れる**）。
 */

import { describe, expect, it } from "vitest";
import { type LoopRole, procedureText } from "./procedure-doc";

const ROLES: LoopRole[] = ["master", "worker"];

/**
 * 出口の節（`### 周回の出口` から、次の `## ` まで）。
 *
 * **`#### 送り方` はこの中にある**——**打つ場所ごと見る**のが主題なので、
 * **節を割って探さない。**
 */
function exitSection(role: LoopRole): string {
  const text = procedureText(role);
  const from = text.indexOf("### 周回の出口");
  expect(from, `${role} の手順書に出口の節が無い`).toBeGreaterThanOrEqual(0);
  return text.slice(from).split("\n## ")[0] ?? "";
}

/**
 * **送るブロック**（`bin/loop-handoff <役> --sent` を打っている bash ブロック）。
 *
 * **散文ではなくブロックを見る** (#341 のレビュー)。**節ぜんぶを見ると
 * 「送れたときにだけ `--sent` を通す」という説明文が先に当たる**ので、
 * **返す行を実際のコマンドより前へ戻しても、説明文より後ろにある限り緑のまま**になる
 * ——**測りたいのは、打つ順序である。**
 */
function sendBlock(role: LoopRole): string {
  const blocks = [...exitSection(role).matchAll(/```bash\n([\s\S]*?)```/g)].map(
    (match) => match[1] ?? "",
  );
  const found = blocks.filter((block) => block.includes(`bin/loop-handoff ${role} --sent`));

  expect(found, `${role} の送るブロックが 1 つに絞れない`).toHaveLength(1);
  return found[0] ?? "";
}

/**
 * 入口 1.0 の、**どの終了経路でも返す**という共通規則の段。
 *
 * **`acquire` の exit 0 の箇条書きだけを見る** (#341 のレビュー)。**入口ぜんぶを見ると、
 * 印がずれた経路や本体を読めなかった経路の `release` が当たる**ので、
 * **共通規則だけを消しても緑のまま**になる。
 */
function commonReleaseRule(role: LoopRole): string {
  const text = procedureText(role);
  const from = text.indexOf("- **exit 0** → 続ける");
  expect(from, `${role} の入口に 1.0 の exit 0 の段が無い`).toBeGreaterThanOrEqual(0);
  return text.slice(from).split("\n- **exit 1**")[0] ?? "";
}

describe.each(ROLES)("%s の出口", (role) => {
  it("返す手が、送るブロックの中にある", () => {
    // **完了条件。** **出口の節を読んだだけで分かること**——**入口（1.0）へ
    // 戻らないと順序が分からない形だと、読む側は「周回を終える」でひとまとめにする**
    expect(sendBlock(role), "返す手が送るブロックに無い").toContain(
      `bin/loop-lease release ${role}`,
    );
  });

  it("返すのは、`--sent` を打ったあとである", () => {
    // **先に返すと、返した先で cron の周回が同じ判定を立てる**
    // ——**指紋が動くのは `--sent` のとき**である。
    //
    // **比べるのは、打つ行どうし**である (#341 のレビュー)——**散文の言及を拾うと、
    // 返す行を実際のコマンドより前へ戻しても緑のまま**になる。
    const block = sendBlock(role);
    const sent = block.indexOf(`bin/loop-handoff ${role} --sent`);
    const release = block.indexOf(`bin/loop-lease release ${role}`);

    expect(sent, "`--sent` を打つ行が無い").toBeGreaterThanOrEqual(0);
    expect(release, "返す行が無い").toBeGreaterThanOrEqual(0);
    expect(release, "`--sent` より先に返している").toBeGreaterThan(sent);
  });

  it("出口のコマンドに混ぜないことが書いてある", () => {
    // **踏み方は「別々に打ち忘れた」ではなく「1 つのコマンドに畳んだ」**である
    // ——**畳むなという注意が、畳む場所に要る**
    // **語で緩めない。** `最後` はこの節の他の話でも出るので、**まぐれで通る**
    expect(exitSection(role), "混ぜないことが書いていない").toContain("出口のコマンドに混ぜない");
  });

  it("入口 1.0 の共通規則は消えていない", () => {
    // **出口を通らずに終わる経路（1.0 / 1.1 の打ち切り）でも返す**
    // ——**そちらは入口が持っている**（Issue の「やらないこと」）。
    // **移すのではなく、打つ場所にも置く**
    //
    // **見るのは 1.0 の exit 0 の段だけ** (#341 のレビュー)——**入口ぜんぶを見ると、
    // 個別経路の `release` が当たり、共通規則を消しても緑のまま**になる。
    const rule = commonReleaseRule(role);

    expect(rule, "1.0 の共通規則から返す手が消えている").toContain(
      `bin/loop-lease release ${role}`,
    );
    expect(rule, "どの終了経路でも返すことが書いていない").toMatch(/必ず返す/);
  });
});
