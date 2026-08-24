/**
 * 戻り先として許してよいオリジン（#451）。
 *
 * **正は「この配備がしゃべる GoTrue の一覧」である。** **開発ではそれが
 * `supabase/config.toml` の 2 行**（`site_url` と `additional_redirect_urls`）
 * ——**GoTrue が実際に突き合わせる一覧**がそこにあり、**アプリ側に別の一覧を置くと、
 * 同じものが 2 箇所になる**（`AGENTS.md` §5。**片方だけ直したときに食い違い、
 * 食い違ったことはどちらの diff にも出てこない**）。
 *
 * **本番の GoTrue は、その設定ファイルを持たない** (#453 のレビュー)——**Supabase の
 * 設定にある一覧が正で、こちらからは読めない**ので、**`AUTH_ALLOWED_ORIGINS` で渡す。**
 * **渡されていればそれだけを見る**——**2 つを混ぜない**（**どちらか一方だけが効くので、
 * 同じものが 2 箇所にある状態にはならない**）。
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
  | { readonly kind: "unreadable"; readonly source: string };

/** 実行時に一覧を渡す口。**本番はこちら**（設定ファイルは置かれない）。 */
const SUPPLIED = "AUTH_ALLOWED_ORIGINS";

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
    return { kind: "unreadable", source: path };
  }
  const site = /^site_url\s*=\s*"([^"]+)"\s*$/m.exec(config);
  const additional = /^additional_redirect_urls\s*=\s*\[(.*)\]\s*$/m.exec(config);
  return {
    kind: "listed",
    listed: [...(site?.[1] === undefined ? [] : [site[1]]), ...quoted(additional?.[1])],
  };
}

/** 1 行から、オリジンだけを取り出す。**取り出せなければ `undefined`。** */
function originOf(pattern: string): string | undefined {
  try {
    // **`*` を含む host は数えない**——**`http://*.example.com` をオリジンとして
    // 許すと、当たる先が広がる**
    const url = new URL(pattern.trim().replace(/\*+$/, ""));
    return url.host.includes("*") ? undefined : url.origin;
  } catch {
    return undefined;
  }
}

/**
 * 実行時に渡された一覧（カンマ区切り）。
 *
 * **1 行でも読めなければ、全体を「読めない」とする**——**落とすと、渡したつもりの
 * 1 本が黙って消え**、**当たらない理由が「許可されていない host」に化ける**
 * （#453 で直したのと同じ向き）。**設定ファイルのほうを落とすのは、
 * GoTrue の書式（`/**` や `*` を含む host）がそのまま並ぶから**である。
 */
function suppliedOrigins(raw: string): AllowedRedirects<string> {
  const entries = raw.split(",").filter((entry) => entry.trim() !== "");
  const origins = entries.map(originOf);
  if (entries.length === 0 || origins.includes(undefined)) {
    return { kind: "unreadable", source: SUPPLIED };
  }
  return { kind: "listed", listed: [...new Set(origins as string[])] };
}

/**
 * 許可されたオリジン。**パスと `*` は落とす**（**オリジンだけを見る**）。
 *
 * **実行時に渡されていれば、そちらだけを見る**（#453 のレビュー）。
 */
export function allowedRedirectOrigins(path = configPath()): AllowedRedirects<string> {
  // **空は「渡していない」と同じに扱う** (#453 のレビュー 2 周目)——**`.env.example` を
  // 写すとここは空で渡る**ので、**「空で定義されている」と「定義されていない」は
  // 見分けられない。** **渡された側へ倒すと、写しただけの開発環境でログインが落ちる。**
  // **何か書いてあるのに 1 つも取れないときは、下で「読めない」へ倒す**
  // （**渡したつもりが効いていない**）。
  const supplied = process.env[SUPPLIED]?.trim();
  if (supplied !== undefined && supplied !== "") {
    return suppliedOrigins(supplied);
  }
  const patterns = allowedRedirectPatterns(path);
  if (patterns.kind === "unreadable") {
    return patterns;
  }
  const origins = new Set<string>();
  for (const pattern of patterns.listed) {
    // **読めない行は数えない**（**許す側へ倒さない**）
    const origin = originOf(pattern);
    if (origin !== undefined) {
      origins.add(origin);
    }
  }
  return { kind: "listed", listed: [...origins] };
}
