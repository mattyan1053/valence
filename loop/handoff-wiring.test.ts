import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type LoopRole, procedureText } from "./procedure-doc";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const PROCEDURES = [{ role: "master" }, { role: "worker" }] as const;

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
  it.each(PROCEDURES)("$role は出口で持ち手を決める", ({ role }) => {
    const doc = procedureText(role);

    expect(doc).toContain("### 周回の出口");
    expect(doc).toContain(`bin/loop-handoff ${role}`);
  });

  it.each(PROCEDURES)("$role は出口の判断を手順書に書き写さない", ({ role }) => {
    // **判断はスクリプトが持つ。** 2 箇所に持つと、片方だけ直して食い違う
    const section = procedureText(role).split("### 周回の出口")[1]?.split("\n## ")[0] ?? "";

    expect(section).not.toMatch(/changes-requested の PR があれば/);
    expect(section).not.toMatch(/backlog が/);
  });

  it.each(PROCEDURES)("$role の出口が複数あることを、手順書が前提にしている", ({ role }) => {
    // **出口は 1 つではない。** だからこそ「必ず通す」と書く必要がある。
    // ここが 1 つ以下になったら、出口の書き方が変わったということなので読み直す
    expect(exitCount(procedureText(role))).toBeGreaterThan(1);
  });

  it.each(PROCEDURES)("$role の出口は、自分自身へ送ると読めない", ({ role }) => {
    // **`bin/loop-handoff` は自分自身を除く**ので、exit 0 で出るのは相手役だけである。
    // ここに自分の役を書くと、**書いてあるとおり実行して自分へ送ろうとする**
    // （**役の名前が逆**は文面だけで判定できる種類の誤りである）
    const section = procedureText(role).split("### 周回の出口")[1]?.split("\n## ")[0] ?? "";
    const exitZero = section.split("- **exit 0**")[1]?.split("- **exit 1**")[0] ?? "";

    expect(exitZero).not.toContain(`\`${role}\``);
  });
});

describe("送れたときだけ記録する", () => {
  /** 出口の節。**送る手順が書いてあるのはここだけ**である。 */
  function exitSection(role: LoopRole): string {
    return procedureText(role).split("### 周回の出口")[1]?.split("\n## ")[0] ?? "";
  }

  it.each(PROCEDURES)("$role は、送信が成功したあとに --sent を通す", ({ role }) => {
    // **判断した周回が「送信済み」を書いていた**ので、**送信が失敗しても記録だけが残る**
    // （#258）——**同じ状態では 2 通目を送らない**ので、**その状態では二度と送られない**。
    // **記録を上げるのは、送れたことを知っている側**である
    expect(exitSection(role)).toContain(`bin/loop-handoff ${role} --sent`);
  });

  it.each(PROCEDURES)("$role は、送れなかったら --sent を通さないと書いてある", ({ role }) => {
    // **書いていないと、「送った扱い」に倒れる**——**倒れる向きが悪い**
    // （送っていないのに二度と送られない）
    expect(exitSection(role)).toMatch(/送れなかった|失敗した/);
  });

  it.each(PROCEDURES)("$role は、送る直前に宛先を引き直す", ({ role }) => {
    // **セッションの表示名は変わる**（`valence-master-d4` → `loop-master`）。
    // **古い名前で送ると明確に失敗する**ので、**キャッシュした名前を使わない**。
    // **2.1 にしか書いていないと、出口からは読まれない**（実際にそうなっていた）
    expect(exitSection(role)).toContain("ListAgents");
  });

  it.each(PROCEDURES)("$role は、宛先を引けないことも送信の失敗として扱う", ({ role }) => {
    // **引けなかったのに `--sent` を通すと、届いていない状態が送信済みになる**
    const section = exitSection(role);

    expect(section).toMatch(/引けなかった|居なければ/);
  });
});

describe("状態が矛盾したとき", () => {
  it.each(PROCEDURES)("$role の出口に exit 3 の行き先が書いてある", ({ role }) => {
    // **「送るものが無い」と「状態が矛盾している」を混ぜない**（#105）。
    // 混ぜると、食い違いが起きても**どこにも記録が残らない**
    const section = procedureText(role).split("### 周回の出口")[1]?.split("\n## ")[0] ?? "";

    expect(section).toMatch(/- \*\*exit 3\*\*/);
    expect(section).toContain("handoff-mismatch");
  });

  it.each(PROCEDURES)("$role は、食い違いを番号ごとに積む", ({ role }) => {
    // **食い違いは 2 本以上あることがある** (#449)。**`bin/loop-stall` は識別子ごとに
    // 数える**ので、**1 本ぶんしか打たないと、選ばれなかった PR は一度も積まれない**
    // ——**先に選ばれたほうが片付くまで、人は呼ばれない。**
    //
    // **番号は `bin/loop-handoff` に訊く**（**`[WARN]` の文面から拾わせない**）。
    const section = procedureText(role).split("### 周回の出口")[1]?.split("\n## ")[0] ?? "";

    expect(section, "番号を訊いていない").toContain(`bin/loop-handoff ${role} --mismatched`);
    expect(section, "番号ごとに打っていない").toContain(
      'bin/loop-stall "handoff-mismatch:$number"',
    );
    expect(section, "単数のまま残っている").not.toContain("handoff-mismatch:<PR番号>");
  });

  it.each(PROCEDURES)("$role は、番号を読めなかったときに素通りしない", ({ role }) => {
    // **`$( )` は終了コードを捨てる** (#454 のレビュー)——**取得に失敗しても、
    // 出力が空なら「食い違い 0 件」として素通りする**（**exit 3 を見ているのに、
    // 停止カウンタが 1 件も動かない**）。
    //
    // **古い版のスクリプトは `--mismatched` を知らない**ので **usage で落ちる**
    // ——**手順書だけが新しい並びは、同期の窓の中で実在する**（#281 と同じ形）。
    const section = procedureText(role).split("### 周回の出口")[1]?.split("\n## ")[0] ?? "";

    expect(section, "終了コードを捨てている").not.toContain(
      `for number in $(bin/loop-handoff ${role} --mismatched)`,
    );
    expect(section, "出力を先に受けていない").toContain(
      `="$(bin/loop-handoff ${role} --mismatched)"`,
    );
    // **「0 件」と「判定できない」を分ける**（**混ぜると、読めない周回が健全に見える**）
    expect(section, "終了コードで分けていない").toContain('case "$?" in');
    expect(section, "判定できないぶんを数えていない").toContain(
      "bin/loop-stall mismatch-lookup-failed",
    );
  });

  it("停止識別子が用意されている", () => {
    expect(read("bin/loop-stall")).toContain("handoff-mismatch");
  });

  describe("まだ誰も答えていない指摘", () => {
    /** master のステップ 4。**返信を確かめる段**である。 */
    function stepFour(): string {
      return procedureText("master").split("\n## 4. ")[1]?.split("\n## 5. ")[0] ?? "";
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

    it("要求は 1 つの口から出している", () => {
      // **順序（label が先、コメントが後）と付け直しは、`bin/loop-request-changes` が
      // 持つようになった** (#388)——**手順を並べると、いつか 1 つ飛ばされる**
      // （**2026-08-22 に master が実際に飛ばした**。#382）。
      //
      // **段そのものに範囲を絞る。** ステップ 4 全体で見ると、**別の節にある同じ
      // 命令に当たって**、この段が無くても緑になる（実際になった）
      const section = stepFour().split("まだ誰も答えていない指摘")[1]?.split("\n### ")[0] ?? "";

      expect(positionOf(section, "bin/loop-request-changes")).toBeGreaterThanOrEqual(0);
    });

    it("生の label 操作が、この段に残っていない", () => {
      // **残っていると、そちらを打つ人が出る**——**忘れるのは、打つ手順があるから**である。
      // **順序と付け直しそのものは `bin/loop-request-changes.test.ts` が見ている**
      const section = stepFour().split("まだ誰も答えていない指摘")[1]?.split("\n### ")[0] ?? "";

      expect(section, "label を手で付けている").not.toContain("--add-label changes-requested");
      expect(section, "label を手で外している").not.toContain("--remove-label changes-requested");
    });

    it("機械的に付けるとは書いていない", () => {
      // **外出しするものや、直さないと決めるものには付けない。**
      // 「レビューが来たら付ける」に読める書き方だと、**当否の判断が消える**
      expect(stepFour()).toMatch(/当否を判断/);
    });
  });

  it.each(PROCEDURES)("$role は exit 3 でも送ると書いてある", ({ role }) => {
    // **記録するために黙ると、#105 が塞ごうとした沈黙をそのまま作る**
    const section = procedureText(role).split("### 周回の出口")[1]?.split("\n## ")[0] ?? "";
    // **切るのは次の箇条書き**である (#449)。**空行で切ると、ブロックを 1 つ
    // 足しただけで判定の範囲が縮む**——**中身は変わっていないのに緑になる。**
    const exitThree = section.split("- **exit 3**")[1]?.split("\n- **exit ")[0] ?? "";

    expect(exitThree).toMatch(/送/);
    // **送らない周回でも記録する。** 飛ばすと、同じ状態が続く間ずっと 1 回のままになる
    expect(exitThree).toMatch(/出力が無くても|送らない周回でも/);
  });
});
