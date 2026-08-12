import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

const PROCEDURE = ".claude/commands/loop-master.md";

/** 見出しで区切った 1 節。**節の外の散文で条件が満たされない**ようにする。 */
function section(heading: string): string {
  const after = read(PROCEDURE).split(heading)[1] ?? "";
  return after.split(/\n#{2,4} /)[0] ?? "";
}

/** その節の bash ブロック（打つ順序は、打つところで見る）。 */
function blocks(text: string): string[] {
  return text
    .split("```bash")
    .slice(1)
    .map((chunk) => chunk.split("```")[0] ?? "");
}

/** 見つからなければ落とす。**`indexOf` の -1 が「手前にある」を満たす**ため。 */
function positionOf(haystack: string, needle: string): number {
  const at = haystack.indexOf(needle);
  if (at < 0) {
    throw new Error(`見つからない: ${needle}`);
  }
  return at;
}

/** 最後に現れる位置。**手前の 1 つで満たされない**ようにする。 */
function lastPositionOf(haystack: string, needle: string): number {
  const at = haystack.lastIndexOf(needle);
  if (at < 0) {
    throw new Error(`見つからない: ${needle}`);
  }
  return at;
}

/**
 * **その PR へ、その周回の判断を書く節**を全部並べる。
 *
 * **絞ってから見ない。** 置いた場所を名指しすると、**名指ししなかった経路が隠れる**
 * （#164 で同じことを直した）。**書く節をすべて出し、扱いを添えて突き合わせる**。
 */
function writingSections(): [string, string][] {
  // **PR へ書く**もの: コメント・label・resolve・**SHA 付きの記録**。
  // Issue の起票や `ready` の付け替えは、**その PR の head に依らない**ので入れない。
  const writes =
    /gh pr comment|gh pr edit|resolveReviewThread|resolve|bin\/loop-stall "[a-z-]+:<PR番号>@<SHA>"/;
  const pairs: [string, string][] = [];
  let heading = "";
  let writesHere = false;
  let checkedFirst = false;
  const flush = () => {
    if (heading !== "" && writesHere) {
      pairs.push([heading, checkedFirst ? "確かめてから書く" : "確かめない"]);
    }
  };
  for (const line of read(PROCEDURE).split("\n")) {
    if (/^#{2,4} /.test(line)) {
      flush();
      heading = line.trim();
      writesHere = false;
      checkedFirst = false;
    }
    // **確認が先にあるか**を見る。**節のどこかにあれば緑、では枝を見落とす**——
    // **片方の枝にしか無い**形が実際に残っていた（#166 のレビュー 2 周目）。
    // **同じ行に両方あるときは、その行が確認である**（散文で両方に触れる場合）
    if (line.includes("bin/loop-head same") && !writesHere) {
      checkedFirst = true;
    }
    // **「resolve しない」は書かない宣言である。** 打ち消しを書き込みと読むと、
    // **節の冒頭で必ず立ち上がり、どこに確認を置いても「確かめない」**になる
    if (writes.test(line) && !line.includes("resolve しない")) {
      writesHere = true;
    }
  }
  flush();
  return pairs;
}

/**
 * 評価した head と、記録・投稿する head を食い違わせない（#145）。
 *
 * **master は 1 周の中で head を何度も読む。** 読むたびに違いうるので、
 * **評価していない head へ「指摘が残っている」と記録しかける**。
 *
 * **実測**（#165 の周回）: 要求を投げてから返るまでの数分に worker が push し、
 * **レビュー 2 回目の枠を、既に消えた head に使った**。
 *
 * **ずれを作らないと、この直しは 1 度も通らない**——**動いていない周回だけを見ると、
 * 何もしなくても緑**になる。だから**スクリプト側は実際に動かして確かめ**
 * （`bin/loop-head.test.ts`）、ここでは**配線されていること**だけを見る。
 */
describe("周回の途中で動く head", () => {
  it("記録する前に、head が動いていないか確かめる", () => {
    // **記録が「どの head を見た判断か」を偽らせない。** 順序が逆だと、
    // **確かめる前に記録が残る**——**その記録はもう消せない**
    const [block = ""] = blocks(section("### 3.2 レビューを要求してよいか確かめる")).filter(
      (chunk) => chunk.includes("bin/loop-review-head"),
    );

    expect(positionOf(block, "bin/loop-head same"), "確かめる前に記録している").toBeLessThan(
      positionOf(block, "bin/loop-review-head"),
    );
  });

  it("記録する head を、読み直さない", () => {
    // **読み直した瞬間に、それは「評価した head」ではなくなる。**
    // **ゲートが出した値をそのまま使う**——**単一の正**である
    const [block = ""] = blocks(section("### 3.2 レビューを要求してよいか確かめる")).filter(
      (chunk) => chunk.includes("bin/loop-review-head"),
    );

    expect(block, "記録の直前に head を読み直している").not.toContain("headRefOid");
  });

  it("待ったあとにも確かめる", () => {
    // **いちばん広い窓がここ**である。**要求を投げてから返るまでの数分**が、
    // まるごとずれうる時間になっている（`bin/loop-await-review` が入って周回が長くなった）。
    //
    // **返ってきたレビューは、待つ前の head を見たもの**である——
    // **動いていたら、その指摘がいまの head にも当てはまるかは誰も確かめていない**
    // **手前の 1 つで満たさせない。** 投げる前の確認は既にあるので、
    // **`indexOf` で見ると「待ったあと」を消しても緑のまま**になる
    const [block = ""] = blocks(section("### 3.2 レビューを要求してよいか確かめる")).filter(
      (chunk) => chunk.includes("bin/loop-await-review"),
    );

    expect(positionOf(block, "bin/loop-await-review"), "待つ前しか確かめていない").toBeLessThan(
      lastPositionOf(block, "bin/loop-head same"),
    );
  });

  it("評価に基づいて書く節を、全部並べて突き合わせる", () => {
    // **名指しで見ない。** 前の版は `section("#### rework …")` のように
    // **置いた場所だけを名指し**していたので、**名指ししなかった経路を隠した**——
    // **実際に 3 つ漏れていた**（`changes-requested` の確認 / まだ誰も答えていない指摘 /
    // 人を呼ぶ）。**本文が挙げた例は、経路の一覧ではない**（master の指摘）。
    //
    // **#164 と同じ形にする。** 節と扱いを**全部並べて `toEqual`**——
    // **経路が増えたら、ここで必ず立ち止まる**。散文で並べても、
    // **経路が増えればまた漏れる**（#92 で出口を 1 本にしたときと同じ話）。
    expect(writingSections()).toEqual([
      // **マージだけは GitHub 側が同じことを確かめる**（`--match-head-commit`）。
      // **#145 の本文が手本にした手当てそのもの**なので、二重には置かない
      ["### exit 0 — マージする", "確かめない"],
      ["### 要求が満たされたか確かめる（`changes-requested`）", "確かめてから書く"],
      ["### 3.2 レビューを要求してよいか確かめる", "確かめてから書く"],
      // 節の導入。**ここでは何も書かない**（下の節がそれぞれ書く）
      ["## 4. 対応を確認し、resolve するか worker へ返す", "確かめない"],
      ["### まだ誰も答えていない指摘", "確かめてから書く"],
      ["### 返信を確かめる", "確かめてから書く"],
      ["#### rework — worker へ差し戻す", "確かめてから書く"],
      ["#### human — 人を呼ぶ", "確かめてから書く"],
      ["#### defer — Issue へ外出ししてマージする", "確かめてから書く"],
      // **先行 PR の依存で決まる**ので、head の中身に依らない
      ["### PR を保留にする / 再開する", "確かめない"],
      // **優先順の伝達**であって、評価に基づく投稿ではない
      ["### 割り込みを伝える", "確かめない"],
    ]);
  });

  it("待った結果を、確認で上書きしない", () => {
    // **この手順書は人が上から実行する**ので、**「直前のコマンドの終了コード」は
    // 最後の 1 つ**である。`bin/loop-await-review` の直後に別のコマンドを置くと、
    // **exit 1（返らなかった）と exit 2（読めない）が 0 に化ける**——
    // **枠を無駄に払い、判定不能なまま進む**（master の指摘。**位置だけを見ると通る**）。
    //
    // **先に受けてから使う**（`bin/loop-review-commits` の受け方が手本）
    const [block = ""] = blocks(section("### 3.2 レビューを要求してよいか確かめる")).filter(
      (chunk) => chunk.includes("bin/loop-await-review"),
    );

    expect(block, "待った結果を受けていない").toMatch(/bin\/loop-await-review[^\n]*\n?[^\n]*\$\?/);
    expect(positionOf(block, "await"), "受けた結果を見ないまま head を確かめている").toBeLessThan(
      lastPositionOf(block, "bin/loop-head same"),
    );
    expect(block, "返っていないのに head を確かめている").toMatch(/if .*await/);
  });

  it("動いたのと読めないのを、別の名前で数える", () => {
    // **主体が違う。** 動いた原因は **worker の push**、読めない原因は
    // **`gh` / 認証 / GitHub** である——**worker の push では解けないもの**を
    // worker の周回で待つと、**元気に push している間ずっと数えられない**。
    //
    // **#128 は「同じ状態には同じ名前」だった。** これは**逆に「違う状態には違う名前」**である
    const procedure = read(PROCEDURE);

    expect(procedure, "動いたときの行き先が無い").toContain('bin/loop-stall "head-moved:<PR番号>"');
    expect(procedure, "読めないときの行き先が無い").toContain(
      'bin/loop-stall "head-lookup-failed:<PR番号>"',
    );
    expect(procedure, "混ざったままの名前が残っている").not.toContain("head-unconfirmed");
  });

  it("その識別子が、一覧にある", () => {
    // **一覧に無い識別子は弾かれる**（`bin/loop-stall` は書式まで見る）。
    // **手順書だけに書くと、打っても数えられない**
    const listed = execFileSync(join(REPO_ROOT, "bin/loop-stall"), ["--list"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    expect(listed).toContain("head-moved:<PR番号>");
    expect(listed).toContain("head-lookup-failed:<PR番号>");
  });

  it("識別子に head SHA を入れない", () => {
    // **入れると、ずれるたびに別の SHA になり、数え直しで 3 周に届かない**——
    // **ここで数えたいのは「同じ PR で、ずれが続いていること」**である
    expect(read(PROCEDURE), "ずれの識別子に SHA が入っている").not.toContain(
      "head-moved:<PR番号>@",
    );
  });

  it("停止識別子に写す SHA は、ゲートが出したものだと書いてある", () => {
    // **`<SHA>` をどこから取るかが書かれていないと、その場で読み直す**——
    // **それがこの Issue の形そのもの**である
    expect(section("### 3.1 ゲート")).toMatch(/ゲートが出した head|ゲートが出力した SHA/);
  });
});
