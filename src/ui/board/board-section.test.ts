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
      .filter((path) => readFileSync(path, "utf8").includes("<h2"))
      .map((path) => path.slice(SRC_ROOT.length));

    expect(written, "`<h2>` を書いている場所が無い").not.toEqual([]);
    expect(written, `節の見出しを、自分で書いている場所がある: ${written.join(" ")}`).toEqual([
      RULE,
    ]);
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
