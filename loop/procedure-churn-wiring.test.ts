/**
 * **捨てた周回が、どこにも残らない**（#367）。
 *
 * **手順とスクリプトを直す PR が続けて入ると、実装側の周回は毎回捨てられる。**
 * **捨てた周回は何もしない**ので、**外からは「回っているのに手が付かない」**に見える
 * ——**打ち切りは `main-sync-failed` を消して終わり**（#266）、
 * **`bin/loop-stall` は「始めたばかり」と答える**（捨てて呼び直すたびに始まり直す）。
 *
 * **止める判断は変えない。** **古い手順で走り続けるより捨てるほうが安全**である
 * ——**足すのは「捨てたことが分かる」側だけ**。
 *
 * **実測**（2026-08-22。約 2 時間）: **worker-1 の周回が、手順を触る PR 3 本の間、
 * 毎回 `changed=0` で捨てられていた。**
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { procedureText } from "./procedure-doc";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 入口の 1.1（同期と判定）だけを切り出す。**別の節の言い回しを拾わない。** */
function syncSection(): string {
  const section = procedureText("worker")
    .split("### 1.1 `origin/main` の先端へ移る")[1]
    ?.split("\n### ")[0];
  if (section === undefined) {
    throw new Error("入口に 1.1 の節がありません");
  }
  return section;
}

/** 呼び直しの手前で何をするかが書かれた bash ブロック。 */
function rerunBlock(): string {
  const block = syncSection()
    .split("```bash")
    .slice(1)
    .map((chunk) => chunk.split("```")[0] ?? "")
    .find((chunk) => chunk.includes("/loop-worker"));
  if (block === undefined) {
    throw new Error("呼び直しの手順が bash ブロックに書かれていません");
  }
  return block;
}

describe("捨てた周回を数える", () => {
  it("捨てる手順が、捨てたことを数える", () => {
    // **これが無いと、続いても人が呼ばれない**——**#367 の本体**
    expect(rerunBlock(), "捨てたことを数えていない").toContain("bin/loop-stall procedure-churn");
  });

  it("数えたものを、同じ手順で消さない", () => {
    // **消すのは同期の失敗のぶんだけ**（#266）——**一緒に消すと毎周 0 に戻り、
    // 3 周へ永久に届かない**（この Issue が塞ぎに来た形そのもの）
    expect(rerunBlock(), "数えた先から消している").not.toContain("--reset procedure-churn");
  });

  it("前へ進めた周回では消す", () => {
    // **続いていないなら残さない**——**残すと、無関係な障害で人が呼ばれる**
    expect(syncSection(), "前へ進めても消していない").toContain(
      "bin/loop-stall --reset procedure-churn",
    );
  });

  it("止める判断は変えない", () => {
    // **足すのは「分かる」側だけ**である——**古い手順で走り続ける形にしない**
    expect(syncSection()).toMatch(/1 以外/);
    expect(syncSection()).toMatch(/126 \/ 127/);
  });

  it("識別子が一覧にある", () => {
    // **綴りが 1 文字違うだけで、別状態として数え直され、3 周続いても止まらない**
    const listed = execFileSync(join(REPO_ROOT, "bin/loop-stall"), ["--list"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    expect(listed).toContain("procedure-churn");
  });

  it("master の手順は変えていない", () => {
    // **当たっているのは worker 側**である（#367 の完了条件）——
    // **マージするのは master 自身**なので、捨てた直後に呼び直せば `main` は動かない
    expect(procedureText("master"), "master 側にも入れている").not.toContain("procedure-churn");
  });
});
