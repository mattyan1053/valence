/**
 * **戻り先が、Supabase の許可一覧に載っていること。**
 *
 * **`site_url` と `additional_redirect_urls` は「*exact* URLs」の一覧**である
 * （`supabase/config.toml` のコメント自身がそう書いている）。**根っこだけ許しても、
 * `/auth/callback` 付きは当たらない**——**GoTrue は `site_url` へ落として戻す**ので、
 * **コールバックの Route Handler が呼ばれず、保存まで進まない**（#224 のレビュー）。
 *
 * **「通った」で終わらせない。** **`localhost` は通る実装もありうる**が、
 * **明示しておけば、どちらの実装でも同じ結果になる**——**「たまたま通っていた」を
 * 残さない。**
 *
 * **倒す先は 2 つある。** **`127.0.0.1` で開いた人が落ちる**のと、
 * **広げすぎて開いた転送になる**——**両方をここで見る。**
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { callbackUrl } from "./urls";

const CONFIG = fileURLToPath(new URL("../../../supabase/config.toml", import.meta.url));

/** `additional_redirect_urls = ["…", "…"]` を読む。**書式が変わったら空になる。** */
function allowedRedirects(): string[] {
  const config = readFileSync(CONFIG, "utf8");
  const line = /^additional_redirect_urls\s*=\s*\[(.*)\]\s*$/m.exec(config);
  if (line?.[1] === undefined) {
    return [];
  }
  return [...line[1].matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);
}

/**
 * GoTrue の突き合わせ方に合わせる。**`**` は `/` も跨ぐ**、`*` は跨がない。
 *
 * **自前で書く理由**——**許可の形だけを見たい**ので、GoTrue を起こさない。
 * **広げすぎを見る側**でもあるので、**素通しにはしない。**
 */
function matches(pattern: string, url: string): boolean {
  // **`**` で切ってから組み立てる。** 置換の途中に印を挟むと、
  // **その印が入った URL で結果が変わる。**
  const expanded = pattern
    .split("**")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join(".*");
  return new RegExp(`^${expanded}$`).test(url);
}

function allows(url: string): boolean {
  return allowedRedirects().some((pattern) => matches(pattern, url));
}

describe("コールバックの戻り先", () => {
  it("読み取りそのものが空振りしていない", () => {
    // **0 件でも「一致しない」で赤くなるが、原因が読めない**——先に言う。
    expect(allowedRedirects().length, "config.toml から許可一覧を読めていない").toBeGreaterThan(0);
  });

  it("localhost と 127.0.0.1 の、実際に渡す URL が許されている", () => {
    // **URL は `urls.ts` から取る。** **ここに書き写すと、片方だけ変わったときに
    // 食い違ったまま緑になる。**
    for (const origin of ["http://localhost:3000", "http://127.0.0.1:3000"]) {
      const url = callbackUrl(new Request(`${origin}/auth/login`));
      expect(allows(url), `許可されていない: ${url}`).toBe(true);
    }
  });

  it("よその行き先は許されていない", () => {
    // **広げすぎない。** **許可一覧は開いた転送の最後の砦**である。
    for (const url of [
      "https://evil.example.com/auth/callback",
      "http://localhost:3001/auth/callback",
      "http://localhost.evil.example.com/auth/callback",
    ]) {
      expect(allows(url), `許してしまっている: ${url}`).toBe(false);
    }
  });
});
