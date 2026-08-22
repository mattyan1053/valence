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

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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

/**
 * **周回の出口**の節。**ここは、何もしなかった周回も通る**——
 * **捨てた周回だけが通らない**（1.1 で lease を返して呼び直す）。
 */
function exitSection(): string {
  const section = procedureText("worker").split("### 周回の出口")[1]?.split("\n## ")[0];
  if (section === undefined) {
    throw new Error("本体に「周回の出口」の節がありません");
  }
  return section;
}

/** 出口で必ず打つ bash ブロック（`bin/loop-handoff worker` が入っている側）。 */
function exitBlock(): string {
  const block = exitSection()
    .split("```bash")
    .slice(1)
    .map((chunk) => chunk.split("```")[0] ?? "")
    .find((chunk) => chunk.includes("bin/loop-handoff worker"));
  if (block === undefined) {
    throw new Error("出口の手順が bash ブロックに書かれていません");
  }
  return block;
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

  it("判定を抜けただけでは消さない", () => {
    // **`exit 1` が言うのは「手順が入れ替わっていない」だけ**で、**「前へ進んだ」では
    // ない**（#368 のレビュー）——**捨てた周回が積んだぶんを、呼び直した先が
    // まだ何もしないうちに消す。** **同じ事故がもう一度起きても鳴らない。**
    expect(syncSection(), "判定のすぐ後ろで消している").not.toContain(
      "bin/loop-stall --reset procedure-churn",
    );
  });

  it("出口まで来た周回が消す", () => {
    // **捨てた周回は出口へ来られない**（1.1 で返して呼び直す）——
    // **「出口を通った」が、この数え方にとっての「前へ進んだ」である**
    expect(exitBlock(), "出口で消していない").toContain("bin/loop-stall --reset procedure-churn");
  });

  it("何もしなかった周回も、出口を通れば消える", () => {
    // **手が空いている worker は、何もしない周回を正常に終える**——
    // **そこで消えないと、健全なのに 3 周で止まる。**
    // **`loop/STOP` は全ループを止める**ので、**遅らせすぎる側へ倒さない。**
    expect(exitSection(), "出口を必ず通るとは書かれていない").toContain(
      "何もしなかった場合も含めて",
    );
  });

  it("出口でも、消すのはこの識別子だけ", () => {
    // **引数無しの `--reset` は、この周回が見ていない障害のぶんまで消す**（#266）
    expect(exitBlock().match(/bin\/loop-stall --reset(?! procedure-churn)/), "全部消している").toBe(
      null,
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

/**
 * **この数は、その作業場のものである**（#368 のレビュー）。
 *
 * **共有のカウンタに置くと、消える経路が 2 つ残る**——**もう 1 人の worker が
 * 出口を通る**（こちらは 1 度も進んでいないのに消える）と、**master が手順 PR を
 * マージして `--reset` を打つ**。**#367 が狙っているのは「手順 PR のマージと
 * 打ち切りが交互に続く」形**なので、**master が進むたびに消えると、
 * 狙った場面でだけ鳴らない。**
 *
 * **見るのは配列の中身ではなく、振る舞いである**——**2 つ目の作業場を実際に置いて、
 * 本物の `bin/loop-stall` を走らせる。**
 */
describe("捨てた数は、その作業場のものである", () => {
  let parent = "";

  afterEach(() => {
    if (parent !== "") {
      rmSync(parent, { recursive: true, force: true });
      parent = "";
    }
  });

  /** git を共有する作業場を 2 つ作る。**共通ディレクトリが同じで、パスが違う。** */
  function twoWorkspaces(): { a: string; b: string } {
    parent = mkdtempSync(join(tmpdir(), "churn-scope-"));
    const a = join(parent, "a");
    mkdirSync(a);
    const git = (cwd: string, ...args: string[]) => {
      const done = spawnSync("git", args, { cwd, encoding: "utf8" });
      expect(done.status, done.stderr).toBe(0);
    };
    git(a, "init", "--quiet", "-b", "main");
    git(a, "config", "user.email", "test@example.invalid");
    git(a, "config", "user.name", "test");
    writeFileSync(join(a, "seed"), "seed\n");
    git(a, "add", "seed");
    git(a, "commit", "--quiet", "-m", "seed");
    const b = join(parent, "b");
    // **worktree なので `.git` は共有される**——**カウンタの置き場所も同じ**である
    git(a, "worktree", "add", "--quiet", "--detach", b);
    return { a, b };
  }

  /** その作業場で `bin/loop-stall` を打つ。**上限には触れさせない**（止めたいのではない）。 */
  function stall(cwd: string, ...args: string[]): string {
    const done = spawnSync(join(REPO_ROOT, "bin/loop-stall"), args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, LOOP_MAX_STALL_REPEATS: "9" },
    });
    expect(done.status, done.stderr).toBe(0);
    return done.stdout;
  }

  /** `stall id=… count=<n> max=…` の n。 */
  function countOf(output: string): number {
    const found = /count=(\d+)/.exec(output);
    expect(found, `件数が読めない: ${output}`).not.toBeNull();
    return Number(found?.[1]);
  }

  it("別の worker が出口を通っても、こちらの数は残る", () => {
    // **あちらが進んでも、こちらは 1 度も進んでいない**——**消えると 3 周へ届かない**
    const { a, b } = twoWorkspaces();
    stall(a, "procedure-churn");
    stall(a, "procedure-churn");

    stall(b, "--reset", "procedure-churn");

    expect(countOf(stall(a, "procedure-churn")), "別の作業場の前進で消えている").toBe(3);
  });

  it("master が前へ進んでも、こちらの数は残る", () => {
    // **手順 PR をマージするのは master 自身**である——**この Issue が狙っている
    // 「マージと打ち切りが交互に続く」形で、毎回消えることになる**
    const { a, b } = twoWorkspaces();
    stall(a, "procedure-churn");

    stall(b, "--reset");

    expect(countOf(stall(a, "procedure-churn")), "master の前進で消えている").toBe(2);
  });

  it("自分の出口を通れば消える", () => {
    // **前へ進んだ証拠で消えるのは、前へ進んだぶんだけ**（#266）
    const { a } = twoWorkspaces();
    stall(a, "procedure-churn");
    stall(a, "procedure-churn");

    stall(a, "--reset", "procedure-churn");

    expect(countOf(stall(a, "procedure-churn")), "自分の出口で消えていない").toBe(1);
  });
});
