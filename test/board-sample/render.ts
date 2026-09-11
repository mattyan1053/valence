/**
 * **盤面を、開けば見られる 1 枚の HTML にする**（#687）。
 *
 * **アプリに認証の外の口は足さない**（master の判断。#687）——**このアプリは
 * マルチテナントで、誰が何を見てよいかは実行時に決まる**（`AGENTS.md` §1 / §6）。
 * **作った材料しか出さない口であっても、その口が将来どう使われるかは、
 * 足した時点では決められない。**
 *
 * **CSS は焼き込む。** **Tailwind は、描いた markup に出てくる class だけを
 * 材料に組む**——**元のファイルを走査しない**ので、**出た HTML と CSS が
 * 必ず噛み合う**（**走査だと、描いていない class まで入り、描いた class が
 * 漏れても気づけない**）。
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { compile } from "tailwindcss";
import { renderRepositoryBoard } from "../../src/app/repos/[owner]/[name]/page";
import { SAMPLE_REPOSITORY, sampleBoard } from "./fixture";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(`${REPO_ROOT}/`);

/** **この盤面を取った時刻。** **固定する**——**走らせるたびに違う HTML が出ると、差が読めない。** */
const TAKEN_AT = new Date("2026-01-02T03:04:05.000Z");

/**
 * **`@import` を解く。**
 *
 * **相対はそのまま、パッケージ名は `<名前>/index.css`**——**`require.resolve` は
 * 素の名前だと JS の入口を返す**ので、**そのまま渡すと `"use strict"` を
 * CSS として読んで落ちる**（実測）。
 */
async function loadStylesheet(id: string, base: string) {
  const path = id.startsWith(".")
    ? resolve(base, id)
    : require.resolve(id.endsWith(".css") ? id : `${id}/index.css`, { paths: [base, REPO_ROOT] });
  return { base: dirname(path), content: await readFile(path, "utf8"), path };
}

/**
 * **markup に出てくる class を、全部集める。**
 *
 * **実体参照を戻す** (#688 のレビュー 2 周目)。**React は属性値を escape する**ので、
 * **`[&_button]:min-w-24` は `[&amp;_button]:min-w-24` として出てくる**——
 * **そのまま渡すと Tailwind が読めず、規則が 1 つも出ない。** **実際に落ちていた**
 * （**この class だけ素のまま描かれていた**）。
 */
export function classesIn(markup: string): string[] {
  const found = new Set<string>();
  for (const [, value] of markup.matchAll(/class="([^"]*)"/g)) {
    for (const one of decode(value ?? "").split(/\s+/)) {
      if (one !== "") {
        found.add(one);
      }
    }
  }
  return [...found];
}

/** **属性値の実体参照を戻す。** **`&amp;` は最後に戻す**——**先に戻すと二重に解ける。** */
function decode(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&");
}

/**
 * **その class の規則を指す selector。**
 *
 * **英数字と `-` `_` 以外は、backslash で逃がす**（Tailwind が出す形）。
 * 例: `bg-[var(--node-fill)]` → `.bg-\[var\(--node-fill\)\]`
 */
export function selectorFor(className: string): string {
  return `.${className.replaceAll(/[^A-Za-z0-9_-]/g, (one) => `\\${one}`)}`;
}

async function styleFor(markup: string): Promise<string> {
  const source = await readFile(resolve(REPO_ROOT, "src/app/globals.css"), "utf8");
  const compiled = await compile(source, { base: resolve(REPO_ROOT, "src/app"), loadStylesheet });
  return compiled.build(classesIn(markup));
}

/**
 * **書き出す先。** **頼まれていなければ書かない**——**`undefined` を返す。**
 *
 * **黙って作業ツリーへ置かない** (#688 の実装で踏んだ)。**`./task check` も
 * 同じ試験を走らせる**ので、**既定で書くと毎回木が dirty になり**、**次の周回の
 * 冒頭が `bin/loop-stall dirty` で止まる**（**3 周で `loop/STOP` が配られ、
 * 全ループが止まる**）。**`.gitignore` は枝にしか無い**ので、**「無視されるから
 * 大丈夫」は、マージされるまで嘘**である（`AGENTS.md` §5）。
 */
export function outputPath(env: Record<string, string | undefined>): string | undefined {
  const out = env.BOARD_SAMPLE_OUT;
  return out === undefined || out === "" ? undefined : out;
}

/**
 * **判定用の 1 枚。** **開けば見られる**——**サーバもログインも要らない。**
 *
 * **CSS は、組み上がった 1 枚を材料に組む** (#688 のレビュー 2 周目)。**盤面の
 * markup だけを見ない**——**器（`<body>`）に付けた class が材料に入らず、
 * **規則の無いまま出ていた**（**`bg-background` / `text-foreground`**）。
 * **出すものと数えるものを、同じにする。**
 */
export async function renderBoardSample(): Promise<string> {
  const markup = renderToStaticMarkup(
    await renderRepositoryBoard(
      SAMPLE_REPOSITORY,
      {},
      {
        board: async () => sampleBoard(),
        report: () => {},
        now: () => TAKEN_AT,
      },
    ),
  );
  const page = (style: string) =>
    [
      "<!doctype html>",
      '<html lang="ja">',
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      "<title>盤面の見本（作った材料・#687）</title>",
      `<style>${style}</style>`,
      "</head>",
      '<body class="bg-background text-foreground">',
      markup,
      "</body>",
      "</html>",
      "",
    ].join("\n");
  return page(await styleFor(page("")));
}
