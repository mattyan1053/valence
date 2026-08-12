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

  it("worker へ返す前にも確かめる", () => {
    // **スレッドへの返信も同じ**（#145 の本文）。**古い head を読んで書いた指摘**が、
    // **新しい head に対する指摘として並ぶ**
    expect(section("#### rework — worker へ差し戻す")).toContain("bin/loop-head same");
  });

  it("ずれたときの行き先が決まっている", () => {
    // **「捨てる」だけでは、何周でも同じことが起きる。** worker が push し続ける間
    // master が判断できない状態は、**3 周続いたら人を呼ぶ**側に置く
    expect(read(PROCEDURE)).toContain('bin/loop-stall "head-unconfirmed:<PR番号>"');
  });

  it("その識別子が、一覧にある", () => {
    // **一覧に無い識別子は弾かれる**（`bin/loop-stall` は書式まで見る）。
    // **手順書だけに書くと、打っても数えられない**
    const listed = execFileSync(join(REPO_ROOT, "bin/loop-stall"), ["--list"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    expect(listed).toContain("head-unconfirmed:<PR番号>");
  });

  it("識別子に head SHA を入れない", () => {
    // **入れると、ずれるたびに別の SHA になり、数え直しで 3 周に届かない**——
    // **ここで数えたいのは「同じ PR で、ずれが続いていること」**である
    expect(read(PROCEDURE), "ずれの識別子に SHA が入っている").not.toContain(
      "head-unconfirmed:<PR番号>@",
    );
  });

  it("停止識別子に写す SHA は、ゲートが出したものだと書いてある", () => {
    // **`<SHA>` をどこから取るかが書かれていないと、その場で読み直す**——
    // **それがこの Issue の形そのもの**である
    expect(section("### 3.1 ゲート")).toMatch(/ゲートが出した head|ゲートが出力した SHA/);
  });
});
