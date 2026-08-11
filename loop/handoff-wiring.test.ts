import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const PROCEDURES = [
  { role: "master", path: ".claude/commands/loop-master.md" },
  { role: "worker", path: ".claude/commands/loop-worker.md" },
] as const;

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/**
 * 「この周回はここで終わり」と書いてある箇所。**出口である。**
 *
 * **数を数えるのではなく、出口が 1 本に集まっていることを見る。**
 * 場面を並べる形に戻ると、経路が増えたときにまた漏れる。
 */
function exitCount(doc: string): number {
  return [...doc.matchAll(/この周回はここで終わり|何もせず終わる|この周回は終わり/g)].length;
}

describe("周回の出口", () => {
  it.each(PROCEDURES)("$role は出口で持ち手を決める", ({ role, path }) => {
    const doc = read(path);

    expect(doc).toContain("### 周回の出口");
    expect(doc).toContain(`bin/loop-handoff ${role}`);
  });

  it.each(PROCEDURES)("$role は出口の判断を手順書に書き写さない", ({ path }) => {
    // **判断はスクリプトが持つ。** 2 箇所に持つと、片方だけ直して食い違う
    const section = read(path).split("### 周回の出口")[1]?.split("\n## ")[0] ?? "";

    expect(section).not.toMatch(/changes-requested の PR があれば/);
    expect(section).not.toMatch(/backlog が/);
  });

  it.each(PROCEDURES)("$role の出口が複数あることを、手順書が前提にしている", ({ path }) => {
    // **出口は 1 つではない。** だからこそ「必ず通す」と書く必要がある。
    // ここが 1 つ以下になったら、出口の書き方が変わったということなので読み直す
    expect(exitCount(read(path))).toBeGreaterThan(1);
  });

  it.each(PROCEDURES)("$role の出口は、自分自身へ送ると読めない", ({ role, path }) => {
    // **`bin/loop-handoff` は自分自身を除く**ので、exit 0 で出るのは相手役だけである。
    // ここに自分の役を書くと、**書いてあるとおり実行して自分へ送ろうとする**
    // （**役の名前が逆**は文面だけで判定できる種類の誤りである）
    const section = read(path).split("### 周回の出口")[1]?.split("\n## ")[0] ?? "";
    const exitZero = section.split("- **exit 0**")[1]?.split("- **exit 1**")[0] ?? "";

    expect(exitZero).not.toContain(`\`${role}\``);
  });
});

describe("状態が矛盾したとき", () => {
  it.each(PROCEDURES)("$role の出口に exit 3 の行き先が書いてある", ({ path }) => {
    // **「送るものが無い」と「状態が矛盾している」を混ぜない**（#105）。
    // 混ぜると、食い違いが起きても**どこにも記録が残らない**
    const section = read(path).split("### 周回の出口")[1]?.split("\n## ")[0] ?? "";

    expect(section).toMatch(/- \*\*exit 3\*\*/);
    expect(section).toContain("handoff-mismatch");
  });

  it("停止識別子が用意されている", () => {
    expect(read("bin/loop-stall")).toContain("handoff-mismatch");
  });

  describe("まだ誰も答えていない指摘", () => {
    /** master のステップ 4。**返信を確かめる段**である。 */
    function stepFour(): string {
      return (
        read(".claude/commands/loop-master.md").split("\n## 4. ")[1]?.split("\n## 5. ")[0] ?? ""
      );
    }

    /**
     * 現れる位置。**無いものを -1 のまま比べない。**
     *
     * `indexOf` を素で比べると、**探しているものが 1 つも無いときに -1 が返って
     * 順序の表明が通る**——**段がまるごと無い状態を緑にする**。実際に、
     * 段を書く前のこの試験が「手前にある」で緑になっていた。
     */
    function positionOf(section: string, needle: string): number {
      const index = section.indexOf(needle);
      expect(index, `手順書に見つかりません: ${needle}`).toBeGreaterThanOrEqual(0);
      return index;
    }

    it("master の手順書に、まだ答えの無い指摘を扱う段がある", () => {
      // **`bin/loop-handoff` は label が付いている前提で書かれているのに、
      // 付ける段が手順書に無かった**（#149 / #152 で実際に踏んだ）。
      // **PR は健全で worker も普通に対応しているのに、3 周で `loop/STOP` に達する**
      expect(stepFour()).toContain("まだ誰も答えていない指摘");
    });

    it("その段は「返信を確かめる」より手前にある", () => {
      // **返信がまだ 1 つも無いなら、確かめる対象がまだ無い。**
      // 後ろに置くと、**確かめる段を通り抜けた先**にしか書かれていないことになる
      const section = stepFour();

      expect(positionOf(section, "まだ誰も答えていない指摘")).toBeLessThan(
        positionOf(section, "未解決スレッドごとに、次を見る"),
      );
    });

    it("label が先、コメントが後の順序が保たれている", () => {
      // **既存の決まりを変えない。** label を付けてから投稿する
      // （投稿できて label が付かない状態を作らないため）。
      //
      // **段そのものに範囲を絞る。** ステップ 4 全体で見ると、
      // **別の節にある同じ 2 つの命令に当たって**、この段が無くても緑になる（実際になった）
      const section = stepFour().split("まだ誰も答えていない指摘")[1]?.split("\n### ")[0] ?? "";

      expect(positionOf(section, "--add-label changes-requested")).toBeLessThan(
        positionOf(section, "gh pr comment"),
      );
    });

    it("既に付いている PR へ新しい指摘が届いたときは、付け直すと書いてある", () => {
      // **label は PR 全体の状態で、いつ判断したかも表している。**
      // 既に付いていると `--add-label` は何も起こさない——**新しい指摘を見た記録が
      // 残らないので、持ち手が master のまま動かず、worker へ渡らない**。
      // 付け直さない限り、**この段を通っても状態が変わらない**
      const section = stepFour().split("まだ誰も答えていない指摘")[1]?.split("\n### ")[0] ?? "";

      expect(section).toContain("--remove-label changes-requested");
    });

    it("機械的に付けるとは書いていない", () => {
      // **外出しするものや、直さないと決めるものには付けない。**
      // 「レビューが来たら付ける」に読める書き方だと、**当否の判断が消える**
      expect(stepFour()).toMatch(/当否を判断/);
    });
  });

  it.each(PROCEDURES)("$role は exit 3 でも送ると書いてある", ({ path }) => {
    // **記録するために黙ると、#105 が塞ごうとした沈黙をそのまま作る**
    const section = read(path).split("### 周回の出口")[1]?.split("\n## ")[0] ?? "";
    const exitThree = section.split("- **exit 3**")[1]?.split("\n\n")[0] ?? "";

    expect(exitThree).toMatch(/送/);
    // **送らない周回でも記録する。** 飛ばすと、同じ状態が続く間ずっと 1 回のままになる
    expect(exitThree).toMatch(/出力が無くても|送らない周回でも/);
  });
});
