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

describe.each(ROLES)("%s の出口", (role) => {
  it("返す位置が、出口の節に書いてある", () => {
    // **完了条件。** **出口の節を読んだだけで分かること**——**入口（1.0）へ
    // 戻らないと順序が分からない形だと、読む側は「周回を終える」でひとまとめにする**
    expect(exitSection(role), "返す手が出口の節に無い").toContain(`bin/loop-lease release ${role}`);
  });

  it("返すのは、`--sent` を通したあとである", () => {
    // **先に返すと、返した先で cron の周回が同じ判定を立てる**
    // ——**指紋が動くのは `--sent` のとき**である
    const section = exitSection(role);
    const sent = section.indexOf("--sent");
    const release = section.indexOf(`bin/loop-lease release ${role}`);

    expect(sent, "`--sent` が出口の節に無い").toBeGreaterThanOrEqual(0);
    expect(release, "返す手が出口の節に無い").toBeGreaterThanOrEqual(0);
    expect(release, "`--sent` より先に返している").toBeGreaterThan(sent);
  });

  it("出口のコマンドに混ぜないことが書いてある", () => {
    // **踏み方は「別々に打ち忘れた」ではなく「1 つのコマンドに畳んだ」**である
    // ——**畳むなという注意が、畳む場所に要る**
    // **語で緩めない。** `最後` はこの節の他の話でも出るので、**まぐれで通る**
    expect(exitSection(role), "混ぜないことが書いていない").toContain("出口のコマンドに混ぜない");
  });

  it("入口の規則は消えていない", () => {
    // **出口を通らずに終わる経路（1.0 / 1.1 の打ち切り）でも返す**
    // ——**そちらは入口が持っている**（Issue の「やらないこと」）。
    // **移すのではなく、打つ場所にも置く**
    const entry = procedureText(role).split("### 周回の出口")[0] ?? "";

    expect(entry, "入口から返す規則が消えている").toContain(`bin/loop-lease release ${role}`);
  });
});
