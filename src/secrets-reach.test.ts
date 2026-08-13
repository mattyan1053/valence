import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL(".", import.meta.url));

/**
 * **サーバ専用の秘密が、クライアントへ渡るコードから届かないこと**（`AGENTS.md` §6）。
 *
 * **`NEXT_PUBLIC_` を付けない、だけでは足りない。** **サーバ専用の値を import した先が
 * client component だと、その値はバンドルへ入る**——**付いていないから安全、ではない。**
 *
 * **レイヤ境界（`.dependency-cruiser.mjs`）では見られない。** あちらは**どのフォルダから
 * どのフォルダへ**を見るが、**`"use client"` はファイルの中身**である——
 * **同じ `src/app` の中に、サーバで動くものとクライアントで動くものが混ざる。**
 *
 * **だから、ここで見る。** **「守る」と書いて終わりにしない**——
 * **散文にはあるが、実行されるものには無い**を、この repo は何度も踏んでいる。
 */
describe("秘密がクライアントへ届かない", () => {
  /** サーバ専用の値を読むモジュール（`process.env` を触る側）。 */
  const SERVER_ONLY = [
    "infrastructure/crypto/token-cipher.ts",
    "infrastructure/github/app-credentials.ts",
  ];

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        return sourceFiles(full);
      }
      return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
    });
  }

  /**
   * そのファイルが import している、この repo の中のファイル。
   *
   * **`@/` も辿る**（#215 のレビュー）。**`tsconfig.json` の `paths` で有効**なので、
   * **相対 import しか見ないと、`@/composition/...` を読んだ時点で辺が消える**——
   * **その先が秘密へ届いていても緑のまま**になる。**経路が 2 つあるなら、入力も 2 つ要る。**
   */
  /** 1 つの import 先を、ファイルへ落とす。**解決できなければ空**。 */
  function resolveImport(file: string, specifier: string): string[] {
    const target = specifier.startsWith("@/")
      ? resolve(SRC, specifier.slice("@/".length))
      : resolve(dirname(file), specifier);
    for (const suffix of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      const candidate = `${target}${suffix}`;
      // 解決できないものは `.dependency-cruiser.mjs` が別に見ている
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return [candidate];
      }
    }
    return [];
  }

  function localImports(file: string): string[] {
    const body = readFileSync(file, "utf8");
    return [...body.matchAll(/(?:from|import)\s+"((?:\.|@\/)[^"]*)"/g)].flatMap((match) =>
      resolveImport(file, match[1] ?? ""),
    );
  }

  /** そこから辿り着けるファイル全部（**間接でも漏れる**ので、推移で見る）。 */
  function reachableFrom(entry: string): Set<string> {
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const current = queue.pop() as string;
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
      queue.push(...localImports(current));
    }
    return seen;
  }

  /**
   * その中身が client component か。
   *
   * **先頭固定では足りない**（#215 のレビュー 2 周目）——**ライセンスや JSDoc を
   * 置いた client component が候補から外れる**（`@/` と同じ形）。
   * **先頭のコメントを読み飛ばしてから見る。**
   *
   * **行頭一致（`m` フラグ）にはしない。** **関数の中の文字列にも当たる**——
   * **倒す先は 2 つある**（**見逃す側**と、**関係ないファイルを client と読む側**）。
   */
  function hasClientDirective(source: string): boolean {
    let rest = source;
    for (;;) {
      const trimmed = rest.replace(/^\s+/, "");
      if (trimmed.startsWith("//")) {
        rest = trimmed.slice(trimmed.indexOf("\n") + 1);
        continue;
      }
      if (trimmed.startsWith("/*")) {
        const end = trimmed.indexOf("*/");
        if (end === -1) {
          return false;
        }
        rest = trimmed.slice(end + 2);
        continue;
      }
      return /^["']use client["']/.test(trimmed);
    }
  }

  it("先頭のコメントを読み飛ばして、directive を見る", () => {
    // **見逃す側**
    expect(hasClientDirective('"use client";\n')).toBe(true);
    expect(hasClientDirective('// SPDX-License-Identifier: MIT\n"use client";\n')).toBe(true);
    expect(hasClientDirective('/**\n * 画面。\n */\n"use client";\n')).toBe(true);
    expect(hasClientDirective("/* one */ // two\n'use client';\n")).toBe(true);

    // **入れすぎる側**——**関数の中の文字列は directive ではない**
    expect(hasClientDirective('export function f() {\n  return "use client";\n}\n')).toBe(false);
    expect(hasClientDirective('import { x } from "./x";\n"use client";\n')).toBe(false);
    expect(hasClientDirective("export const x = 1;\n")).toBe(false);
    // **閉じていないブロックコメントは、読み飛ばせない**（そこで止める）
    expect(hasClientDirective('/* 閉じていない\n"use client";\n')).toBe(false);
  });

  it("`tsconfig.json` の別名は `@/` のままである", () => {
    // **別名が変わったら、上の走査は辺を落とす。** **落としても緑のまま**なので、
    // **別名そのものを見て、変わったらここで止まる**ようにする
    const tsconfig = readFileSync(resolve(SRC, "..", "tsconfig.json"), "utf8");

    expect(tsconfig, "別名が変わっている（走査も直すこと）").toContain('"@/*": ["./src/*"]');
  });

  it("client component から、サーバ専用のモジュールへ届かない", () => {
    const serverOnly = SERVER_ONLY.map((path) => resolve(SRC, path));
    // **在ることを先に確かめる。** **名前を変えたら、この試験は何も見なくなる**
    for (const path of serverOnly) {
      expect(statSync(path).isFile(), `${relative(SRC, path)} が無い`).toBe(true);
    }

    const leaking = sourceFiles(SRC)
      .filter((file) => hasClientDirective(readFileSync(file, "utf8")))
      .flatMap((file) => {
        const reachable = reachableFrom(file);
        return serverOnly
          .filter((secret) => reachable.has(secret))
          .map((secret) => `${relative(SRC, file)} → ${relative(SRC, secret)}`);
      });

    expect(leaking, "秘密がクライアントのバンドルへ入る").toEqual([]);
  });
});
