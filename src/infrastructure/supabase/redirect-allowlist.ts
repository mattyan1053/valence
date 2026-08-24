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
 * **本番はここを見ていない**（**GoTrue の一覧は Supabase 側にある**）。
 * **いま塞いでいるのは開発の入り口**で、**本番の口は、そこを開けるときに要る。**
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CONFIG = fileURLToPath(new URL("../../../supabase/config.toml", import.meta.url));

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
 * **空を返しうる**（**書式が変わった / 読めない**）——**呼ぶ側は「1 つも許されて
 * いない」として扱う**（**開いた転送を作るより、ログインが落ちるほうが軽い**）。
 */
export function allowedRedirectPatterns(): string[] {
  let config: string;
  try {
    config = readFileSync(CONFIG, "utf8");
  } catch {
    return [];
  }
  const site = /^site_url\s*=\s*"([^"]+)"\s*$/m.exec(config);
  const additional = /^additional_redirect_urls\s*=\s*\[(.*)\]\s*$/m.exec(config);
  return [...(site?.[1] === undefined ? [] : [site[1]]), ...quoted(additional?.[1])];
}

/**
 * 許可されたオリジン。**パスと `*` は落とす**（**オリジンだけを見る**）。
 *
 * **`*` を含む host は数えない**——**`http://*.example.com` のような行を
 * オリジンとして許すと、当たる先が広がる。**
 */
export function allowedRedirectOrigins(): string[] {
  const origins = new Set<string>();
  for (const pattern of allowedRedirectPatterns()) {
    try {
      const url = new URL(pattern.replace(/\*+$/, ""));
      if (!url.host.includes("*")) {
        origins.add(url.origin);
      }
    } catch {
      // **読めない行は数えない**（**許す側へ倒さない**）
    }
  }
  return [...origins];
}
