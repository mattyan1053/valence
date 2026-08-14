/**
 * **認証を読む要求が、必ず境界を通るか** (#214)。
 *
 * **通らない経路が 1 つでもあると、そこだけ古い Cookie で動く**（#176 の別の形）。
 * **middleware を選んだのはここを満たせるから**で、**Route Handler は呼ばれたときだけ走る**
 * ——**呼び忘れた画面が 1 つできた瞬間に穴が開く。**
 *
 * **`middleware.ts` を import しない。** **`config.matcher` は Next.js が静的に読む**ので
 * **リテラルでなければならず**、**そこから定数を切り出すと、切り出した側だけを見る試験になる**
 * ——**実物に書いてある文字列を読む。**
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./middleware.ts", import.meta.url), "utf8");

/** 実物に書いてある matcher を取り出す。**写さない。** */
function matchers(): RegExp[] {
  const block = source.match(/matcher:\s*\[([\s\S]*?)\]/);
  if (block?.[1] === undefined) {
    throw new Error("middleware.ts に matcher が見つかりません");
  }
  // **書いてある文字列そのものではなく、実行時の値にする。** **`\\.` は
  // ソースでは 2 文字だが、Next.js が受け取るのは 1 文字**——**写したまま
  // 組み立てると、`favicon\.ico` を「バックスラッシュ + 任意の 1 文字」として読む**
  const patterns = [...block[1].matchAll(/"(?:[^"\\]|\\.)*"/g)].map(
    ([literal]) => JSON.parse(literal) as string,
  );
  if (patterns.length === 0) {
    throw new Error("matcher が空です");
  }
  return patterns.map((pattern) => new RegExp(`^${pattern}$`));
}

/** `src/app/` の下から、実際に開かれる path を作る。 */
function routePaths(dir = new URL("./app/", import.meta.url).pathname, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // **`(group)` は URL に出ない。** **`[id]` は何かが入る**ので、代表を 1 つ置く
      const segment = entry.name.startsWith("(")
        ? ""
        : `/${entry.name.replace(/^\[+\.*(.+?)\]+$/, "sample")}`;
      found.push(...routePaths(join(dir, entry.name), `${prefix}${segment}`));
      continue;
    }
    if (/^(page|route)\.tsx?$/.test(entry.name)) {
      found.push(prefix === "" ? "/" : prefix);
    }
  }
  return found;
}

describe("認証を読む要求は、必ず境界を通る", () => {
  it("`src/app/` の全ての経路が matcher に当たる", () => {
    // **次に足された画面が matcher の外に落ちたら、ここで赤くなる。**
    // **除外を 1 つ足すだけで穴が開く**ので、**除外の側ではなく経路の側から数える**
    const patterns = matchers();
    const uncovered = routePaths().filter(
      (path) => !patterns.some((pattern) => pattern.test(path)),
    );

    expect(uncovered, "この経路は境界を通らない").toEqual([]);
  });

  it("経路を数えている（数え漏れたら空になる）", () => {
    // **上の試験は、経路が 0 件でも緑になる**——**数える側が壊れたことに気づけない**
    expect(routePaths()).toContain("/");
    expect(routePaths().length).toBeGreaterThan(1);
  });

  it("静的なファイルは通さない", () => {
    // **通すと、画像 1 枚ごとにセッションの更新が走る**
    const patterns = matchers();

    for (const path of ["/_next/static/chunk.js", "/_next/image", "/favicon.ico"]) {
      expect(
        patterns.some((pattern) => pattern.test(path)),
        `${path} を通している`,
      ).toBe(false);
    }
  });
});

describe("境界は、誰が何を見られるかを決めない", () => {
  it("行き先を書き換えない", () => {
    // **判断を持つのは画面の側だけ** (#214)。**ここでも判断すると 2 か所になり、
    // 片方だけ古くなる**——**更新するのが境界、読むのが画面である**
    expect(source).not.toMatch(/redirect|rewrite/);
  });
});
