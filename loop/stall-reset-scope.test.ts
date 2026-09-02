/**
 * **`--reset` は名指しで打つ**（#566）。
 *
 * **同じ文書の中で食い違っていた。** **出口は「消すのは `procedure-churn` だけ。
 * 引数無しで打たない」**（#266）と言い、**空転の節は「引数無しの `--reset`」**を出していた
 * ——**worker が出口で後者を当て、引数無しで打った**（**何が消えたかは、消したあとなので
 * 追えない**）。
 *
 * **走らせて測った**（`bin/loop-stall` を空のリポジトリで叩いた）。**引数無しの `--reset` は
 * 記録を 2 ファイル丸ごと消す**——**共有（`valence-loop-stall`）と、打った作業場の
 * ぶん（`valence-loop-stall-<作業場>`）**である。**4 つ積んで打つと 4 つとも消えた。**
 * **他の作業場のぶんだけが残る**（#239）。
 *
 * **だから「この周回が解いたもの」だけを名指しで消す**——**`bin/loop-stall` の
 * `--reset` が 2 つ目の引数を取るのは、そのため**である（#266。スクリプトの冒頭）。
 *
 * **例外は 1 つだけ**——**master がマージのあとに周回を捨てるとき。** **マージは
 * ループ全体が前へ進んだ証拠**なので、**どの記録も数え直してよい**（手順書に理由がある）。
 *
 * **手順書は実行されない。** **押さえるなら試験の側**である（`AGENTS.md` §4）。
 */

import { describe, expect, it } from "vitest";
import { type LoopRole, procedureText } from "./procedure-doc";

/**
 * 渡された本文に出てくる bash ブロック。**散文は数えない**——
 * **「引数無しで打たない」と書いた行まで数えてしまう。**
 *
 * **本文を受け取る**（役ではない）——**「節の外に無いこと」を見たい**ので、
 * **切り出した本文にも同じ目を当てる**（#569 のレビュー 2 周目）。
 */
function codeBlocksOf(text: string): string[] {
  return text
    .split("```")
    .filter((_, index) => index % 2 === 1)
    .map((block) => block.replace(/^bash\n/, ""));
}

/**
 * 対象を渡していない `--reset` の行。**記録を丸ごと消す側**である。
 *
 * **終わりはコメントだけではない** (#569 のレビュー 2 周目)——
 * **`bin/loop-stall --reset || true` も対象を渡していない**ので、
 * **`||` `&&` `;` `|` も終端に数える**（**完全一致では通り抜ける**）。
 */
const BARE_RESET_COMMAND = /^bin\/loop-stall --reset[ \t]*($|[|&;])/;

function bareResetsIn(text: string): string[] {
  return codeBlocksOf(text)
    .flatMap((block) => block.split("\n"))
    .map((line) =>
      line
        .trim()
        .replace(/\s+#.*$/, "")
        .trim(),
    )
    .filter((line) => BARE_RESET_COMMAND.test(line));
}

/**
 * 散文（bash ブロックの外）。**打てと書いてある行が、ここにも出る**
 * ——**ブロックだけを見ていると、箇条書きの「〜を通す」が丸ごと落ちる**（#569 のレビュー）。
 */
function proseLinesOf(text: string): string[] {
  return text
    .split("```")
    .filter((_, index) => index % 2 === 0)
    .flatMap((chunk) => chunk.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * 対象を渡していない `--reset` が出てくる散文の行。
 *
 * **次に来る字で見分ける**（**言い回しでは見分けない**。`AGENTS.md` §4）——
 * **識別子・`<…>`・引用符が続けば名指し**で、**そこで終わっていれば裸**である。
 */
const BARE_RESET = /bin\/loop-stall --reset(?![ \t]*[A-Za-z0-9_<"'$])/;

function bareResetProse(role: LoopRole): string[] {
  return proseLinesOf(procedureText(role)).filter((line) => BARE_RESET.test(line));
}

/**
 * master の「exit 0 — マージする」の節。**引数無しで打ってよい唯一の場面**である。
 *
 * **場面そのものを切り出す** (#569 のレビュー 2 周目)。**`bin/loop-lease release master`
 * を含むブロックは 4 個ある**ので、**「release がある 1 ブロック」では場面を絞れない**
 * ——**同期の失敗で打ち切る側へ移しても、件数もその語も変わらない。**
 */
function mergeSection(): string {
  const text = procedureText("master");
  const from = text.indexOf("### exit 0 — マージする");
  if (from < 0) {
    throw new Error("master の手順書に「exit 0 — マージする」の節がありません");
  }
  return text.slice(from).split("\n### ")[0] as string;
}

/** マージの節を取り除いた残り。**例外がそこにしか無いこと**を、この側で見る。 */
function outsideMergeSection(): string {
  return procedureText("master").split(mergeSection()).join("\n");
}

/**
 * 「空転を検出する」の節。**周回が前へ進んだときに消す、と言っている場所**である。
 *
 * **見出しから切る**（`AGENTS.md` §4）——**語で切ると、入口の目次に当たる**
 * （**節は 1 つでも、その語を持つ行は 2 つある**）。**節の番号は役で違う**ので数えない。
 */
function stallSection(role: LoopRole): string {
  const sections = procedureText(role)
    .split(/\n## /)
    .filter((section) => section.split("\n")[0]?.includes("空転を検出する") === true);
  if (sections.length !== 1) {
    throw new Error(`${role} の手順書の「空転を検出する」の節が ${sections.length} 個あります`);
  }
  return sections[0] as string;
}

/**
 * master の「要求が満たされたか確かめる」の節。**`changes-requested` を外す段**である。
 *
 * **見出しから切る**（`stallSection` と同じ理由）。
 */
function changesRequestedSection(): string {
  const sections = procedureText("master")
    .split(/\n### /)
    .filter((section) => section.split("\n")[0]?.includes("要求が満たされたか確かめる") === true);
  if (sections.length !== 1) {
    throw new Error(
      `master の手順書の「要求が満たされたか確かめる」の節が ${sections.length} 個あります`,
    );
  }
  return sections[0] as string;
}

describe("bin/loop-stall --reset の打ち方", () => {
  it("worker は、引数無しで打たない", () => {
    // **出口は、何もしなかった周回も通る**——**そこで丸ごと消すと、
    // 前の周回が積んだ `local-ci-failed` まで消える**（**まだ赤いのに数え直される**）。
    expect(bareResetsIn(procedureText("worker")), "引数無しの --reset が残っている").toEqual([]);
  });

  it("worker は、消すものを名指しする", () => {
    // **雛形が無いと、読んだ側は引数無しへ戻る**（この Issue の発端がそれである）
    expect(stallSection("worker"), "何を消すのかが書かれていない").toContain(
      "bin/loop-stall --reset <",
    );
  });

  it("master も、空転の節では名指しする", () => {
    expect(stallSection("master"), "何を消すのかが書かれていない").toContain(
      "bin/loop-stall --reset <",
    );
  });

  it("散文にも、裸の --reset を置かない（worker）", () => {
    // **打つ指示は bash ブロックに置く**——**散文に裸の形が残ると、読んだ側はそれを打つ。**
    // **禁止を書きたいときは「カウンタを消さない」と書く**（**命令の形を残さない**）。
    expect(bareResetProse("worker"), "散文に裸の --reset が残っている").toEqual([]);
  });

  it("散文にも、裸の --reset を置かない（master）", () => {
    // **例外（マージのあとの打ち切り）は、下の試験が見ているブロックの中にある。**
    expect(bareResetProse("master"), "散文に裸の --reset が残っている").toEqual([]);
  });

  it("master は、changes-requested を外した周回で消すものを名指しする", () => {
    // **満たされた周回が消すのは、その head の対応待ちである**——**古い head の記録は
    // 別の識別子として既に数え直されている**（同じ節に理由がある）。
    // **末尾まで見る**（#569 のレビュー 2 周目）——**`@<SHA>` を削ると、
    // `bin/loop-stall` は知らない識別子として exit 2 を返す**（**消えない**）。
    // **label は既に外れている**ので、**同じ経路はもう来ない**——**古い対応待ちが残る。**
    expect(changesRequestedSection(), "何を消すのかが書かれていない").toContain(
      'bin/loop-stall --reset "awaiting-worker:<PR番号>@<SHA>"',
    );
  });

  it("master の引数無しは、マージのあとの打ち切りだけ", () => {
    // **役ごとに違ってよい理由は、打つ場面のほうにある**——**マージはループ全体が
    // 前へ進んだ証拠**なので、**共有の記録も数え直してよい。**
    //
    // **場面そのものを切り出して見る**（#569 のレビュー 2 周目）——**「release を含む
    // ブロックが 1 つ」では、同期の失敗で打ち切る側へ移しても気づけない。**
    expect(bareResetsIn(mergeSection()), "マージの節に、引数無しの --reset が無い").toHaveLength(1);
    expect(bareResetsIn(outsideMergeSection()), "マージの節の外で丸ごと消している").toEqual([]);
  });
});
