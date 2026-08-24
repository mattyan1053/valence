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

import { describe, expect, it } from "vitest";
import { allowedRedirectPatterns } from "../../infrastructure/supabase/redirect-allowlist";
import { callbackUrl } from "./urls";

/**
 * **一覧を 2 箇所で読まない** (#451)。**書式を知っているのは
 * `src/infrastructure/supabase/redirect-allowlist.ts` だけ**である
 * ——**ここで読み直すと、片方だけ直したときに食い違う**（`AGENTS.md` §5）。
 */
function allowedRedirects(): string[] {
  const patterns = allowedRedirectPatterns();
  // **読めなければ、そこで落ちる**（**「1 つも許していない」に化けさせない**）
  expect(patterns.kind, "許可一覧を読めていない").toBe("listed");
  return patterns.kind === "listed" ? [...patterns.listed] : [];
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
      // **実物が組む形で渡す** (#451)——**`Host` に開いた先、`url` に待ち受けアドレス**
      const url = callbackUrl(
        new Request("http://0.0.0.0:3000/auth/login", { headers: { host: new URL(origin).host } }),
      );
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
