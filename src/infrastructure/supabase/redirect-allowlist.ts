/**
 * 戻り先として許してよいオリジン（#451）。
 *
 * **正は `supabase/config.toml` の 2 行**である（`site_url` と
 * `additional_redirect_urls`）——**GoTrue が実際に突き合わせる一覧**がそこにあり、
 * **アプリ側に別の一覧を置くと、同じものが 2 箇所になる**（`AGENTS.md` §5。
 * **片方だけ直したときに食い違い、食い違ったことはどちらの diff にも出てこない**）。
 *
 * **読むのはここ 1 箇所である。** **`src/app/auth/redirect-allowlist.test.ts` も
 * この口を通す**——**書式を知っている場所を 2 つ持たない。**
 *
 * **読めなかったことを、「1 つも許していない」と混ぜない** (#453 のレビュー)。
 * **この設定は開発のもの**で、**本番の口に置かれる保証が無い**——**混ぜると、
 * 本番で誰もログインできないのに、理由が「許可されていない host」になる。**
 * **どちらなのかを返し、呼ぶ側が言い分ける。**
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 読めたか、読めなかったか。**混ぜない。** */
export type AllowedRedirects<T> =
  | { readonly kind: "listed"; readonly listed: readonly T[] }
  | { readonly kind: "unreadable"; readonly path: string };

/**
 * 設定の置き場所。**呼ばれたときに組む** (#451 の CI)。
 *
 * **`import.meta.url` から組むと、build のときに評価される**——**Next.js は
 * ページの情報を集める段でここを通り**、**その文脈では `fileURLToPath` が
 * `URL` を受け取れない**（**`Failed to collect page data` で落ちた**）。
 *
 * **リポジトリの根から引く。** **`./task` も vitest も、根で走る。**
 */
function configPath(): string {
  return join(process.cwd(), "supabase", "config.toml");
}

/** `"…"` の並びから、URL だけを取り出す。**書式が変わったら空になる。** */
function quoted(line: string | undefined): string[] {
  if (line === undefined) {
    return [];
  }
  return [...line.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);
}

/**
 * 設定に書かれているとおりの並び（`site_url` と `additional_redirect_urls`）。
 *
 * **`**` を含んだまま返す**——**GoTrue が突き合わせるのはこの形**である。
 *
 * **書式が変わったら空**（**`listed` で 0 件**）——**「読めた。1 つも許していない」**
 * である。**読めなかったのとは別**である。
 */
export function allowedRedirectPatterns(path = configPath()): AllowedRedirects<string> {
  let config: string;
  try {
    config = readFileSync(path, "utf8");
  } catch {
    return { kind: "unreadable", path };
  }
  const site = /^site_url\s*=\s*"([^"]+)"\s*$/m.exec(config);
  const additional = /^additional_redirect_urls\s*=\s*\[(.*)\]\s*$/m.exec(config);
  return {
    kind: "listed",
    listed: [...(site?.[1] === undefined ? [] : [site[1]]), ...quoted(additional?.[1])],
  };
}

/**
 * 許可されたオリジン。**パスと `*` は落とす**（**オリジンだけを見る**）。
 *
 * **`*` を含む host は数えない**——**`http://*.example.com` のような行を
 * オリジンとして許すと、当たる先が広がる。**
 */
export function allowedRedirectOrigins(path = configPath()): AllowedRedirects<string> {
  const patterns = allowedRedirectPatterns(path);
  if (patterns.kind === "unreadable") {
    return patterns;
  }
  const origins = new Set<string>();
  for (const pattern of patterns.listed) {
    try {
      const url = new URL(pattern.replace(/\*+$/, ""));
      if (!url.host.includes("*")) {
        origins.add(url.origin);
      }
    } catch {
      // **読めない行は数えない**（**許す側へ倒さない**）
    }
  }
  return { kind: "listed", listed: [...origins] };
}
