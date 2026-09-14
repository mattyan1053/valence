/**
 * **節の切れ目を、見て分かる強さにする**（#713）。
 *
 * **人が見て言ったこと**（`./task board:sample` の見本を見て、いちばん最初に）:
 *
 * > まず気になったのが、どこに何が書いてあるか画面をみてパット見わからなかった。
 * > たぶん各セクションの区切りの強調が足りないんだと思う。
 *
 * **当たっていた**——**`推奨レビュー順` だけ `text-lg` が無かった**（**3 つの
 * 見出しが、それぞれ別の class を書いていた**）。**大きさが揃っていないのは、
 * 揃えるのを忘れたからではなく、決める場所が 3 つあったから**である。
 *
 * **だから見るのは「揃っているか」ではなく「決める場所が 1 つか」**である
 * （#713 の完了条件——**書き写しでなく**）。**揃っているかだけを見ると、
 * 4 つ目の節を足した人が同じことをもう一度する。**
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BoardSectionProps } from "./board-section";
import { BoardSection } from "./board-section";

const SRC_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** **この 1 箇所だけが `<h2>` を書いてよい。** */
const RULE = join("ui", "board", "board-section.tsx");

/**
 * **その行は、説明の散文か。**
 *
 * **このリポジトリは理由を厚く書く**ので、**判定したい語は散文にもほぼ必ず出てくる**
 * （`AGENTS.md` §4。**`<h2>` はとくに出やすい**——**この試験ファイルの doc コメントに
 * 4 回出ている**）。**本文ぜんぶを 1 つの文字列として見ると、次に `<h2>` を
 * 引き合いに出した人が赤くなる**——**しかも「書いていないのに書いている」と言う**ので、
 * **読んだ人は走査を緩めるほうへ倒れる**（#720 のレビュー）。
 *
 * **落とすのは行ごと。** **本物の JSX がコメント行に乗ることはない**ので、
 * **偽の緑は増えない。**
 */
function isProse(line: string): boolean {
  return /^\s*(\/\/|\/\*|\*|\{\/\*)/.test(line);
}

/**
 * **その版が、節の見出しを自分で書いているか。**
 *
 * **開きタグの形で当てる**——**`</h2>` や、散文の中の「`<h2>` のような」には当てない。**
 *
 * **行末も許す** (#720 のレビュー 2 周目)。**`<h2` の後ろに 1 文字を要求すると、
 * 属性を折り返した開きタグ**（`<h2` で行が終わる）**をすり抜ける**——**そちらは偽の緑**で、
 * **散文に当たる偽の赤より向きが悪い**（**器を使わずに書いた人が、属性を 2 つ書いて
 * 折り返した瞬間に見えなくなる**）。
 */
function writesHeading(text: string): boolean {
  return text.split("\n").some((line) => !isProse(line) && /<h2([\s/>]|$)/.test(line));
}

/** `src` 以下の、試験でない `.tsx` / `.ts`。 */
function sourceFiles(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
      return [];
    }
    return [path];
  });
}

function render(overrides: Partial<BoardSectionProps> = {}): string {
  return renderToStaticMarkup(
    createElement(
      BoardSection,
      { mark: "🧭", title: "推奨レビュー順", ...overrides },
      createElement("p", undefined, "中身"),
    ),
  );
}

describe("節の見出しは、1 箇所が決める（#713）", () => {
  it("`<h2>` を書いているのは、規則を持つファイルだけ", () => {
    // **「揃っているか」を描いた結果で見ない**——**次に足す節は、まだ描かれていない。**
    // **数えた: `<h2` を書いていたのは 4 ファイル**（推奨レビュー順・PR の依存・
    // issue・横断の一覧）で、**そのうち 3 つが 1 リポジトリの盤面に並ぶ。**
    const written = sourceFiles(SRC_ROOT)
      .filter((path) => writesHeading(readFileSync(path, "utf8")))
      .map((path) => path.slice(SRC_ROOT.length));

    expect(written, "`<h2>` を書いている場所が無い").not.toEqual([]);
    expect(written, `節の見出しを、自分で書いている場所がある: ${written.join(" ")}`).toEqual([
      RULE,
    ]);
  });

  it("散文の中の `<h2>` は、書いたことにならない", () => {
    // **判定だけを取り出して、当たる入力と当たらない入力を隣どうしに置く**
    // （`AGENTS.md` §4）——**本物の材料には散文の当たりが 0 件**なので、
    // **盤面越しでは、広い判定と狭い判定が同じ色になる**（**数えた: `main` の
    // `src` 非試験ファイルの `<h2` は 4 件、どれも本物の JSX**）。
    expect(writesHeading(" * **`<h2>` のように書く**"), "doc コメントに当たった").toBe(false);
    expect(writesHeading("// <h2> を引き合いに出す"), "行コメントに当たった").toBe(false);
    expect(writesHeading("      {/* <h2> のこと */}"), "JSX コメントに当たった").toBe(false);
    expect(writesHeading('      <h2 className="text-lg">節</h2>'), "本物の JSX を外した").toBe(
      true,
    );
    expect(writesHeading("      <h2>節</h2>"), "属性の無い JSX を外した").toBe(true);
    // **折り返した開きタグ** (#720 のレビュー 2 周目)。**`main` の `.tsx` に
    // `<h[0-9]` で終わる行は 0 件**なので、**盤面越しでは、行末を許す当て方と
    // 許さない当て方が同じ色になる**——**判定だけを取り出して測る。**
    expect(writesHeading("      <h2"), "折り返した開きタグを外した").toBe(true);
  });

  it("見出しは、本文より大きく、太く出る", () => {
    // **preflight が `h1..h6` の大きさと太さを `inherit` へ落とす**（#583 のレビュー）
    // ——**書かなければ、見出しは本文と 1 ピクセルも違わない。**
    const heading = /<h2(\s[^>]*)?>/.exec(render())?.[0] ?? "";

    expect(heading, "見出しが出ていない").not.toBe("");
    expect(heading, "大きさが書かれていない").toMatch(/\btext-lg\b/);
    expect(heading, "太さが書かれていない").toMatch(/\bfont-bold\b/);
  });

  it("節の上に、切れ目の線が引かれる", () => {
    // **人が言ったのは「区切りの強調が足りない」**である。**線は、明と暗の
    // 両方で定義された色で引く**（`globals.css`。**片方にしか無いと透明で描かれる**）。
    const section = /<section(\s[^>]*)?>/.exec(render())?.[0] ?? "";

    expect(section, "節が出ていない").not.toBe("");
    expect(section, "切れ目の線が無い").toMatch(/\bborder-t\b/);
    expect(section, "線の色が `var\\(--…\\)` で受けられていない").toContain(
      "border-[var(--node-stroke)]",
    );
  });
});

describe("絵文字は、読み上げの邪魔をしない（#713）", () => {
  it("印は読み上げから外れる", () => {
    // **意味を絵文字だけに持たせない**（#713）——**読み上げでは飛ばされるか、
    // 名前がそのまま読まれる。** **見本の `／` が既にそうしている**（`risk-tier-view`）。
    expect(render(), "印が読み上げから外れていない").toContain(
      '<span aria-hidden="true">🧭</span>',
    );
  });

  it("節の名前は、文字で残る", () => {
    // **印を消しても、節の名前は読める**——**印だけになると、何の節かが消える。**
    expect(render({ mark: "" }), "節の名前が文字で出ていない").toContain("推奨レビュー順");
  });
});
