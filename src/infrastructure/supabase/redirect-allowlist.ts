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

/**
 * `"…"` の並びから、URL だけを取り出す。
 *
 * **「読める」の定義を 1 つにする** (#477 のレビュー)——**中身を確かめる側
 * （`fullyQuoted`）と、ここで、空文字の扱いが食い違っていた**（**`[""]` は
 * 「全部読めた」と判定され、ここで落ちる**）。**何にも当たらないパターン**なので
 * **害は無かった**が、**2 つの正規表現が少しずつ違う「読める」を持つ**のは、
 * **判定が 2 段あることに気づけなくなる形**である。
 */
function quoted(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1] as string);
}

/**
 * 配列の中身が、この形で全部読めるか (#469 のレビュー)。
 *
 * **外側が当たっても、中身が全部読めるとは限らない**——**`'` で囲んだ要素は
 * TOML として有効**である。**拾える側だけ返すと、一覧が黙って短くなり**、
 * **ログインの失敗が「許可されていない host」に化ける**（**この直しが消しに来た形**）。
 *
 * **末尾のカンマは書ける形**なので、**読める側に入れる。**
 */
function fullyQuoted(body: string): boolean {
  return /^\s*(?:"[^"]*"\s*,\s*)*(?:"[^"]*"\s*)?$/.test(body);
}

/**
 * その鍵が書かれている行。**無ければ `undefined`**（**書いていない、は読めた側**）。
 *
 * **探す側はゆるく** (#469 のレビュー 3 周目)——**TOML は鍵の前に空白を置ける**ので、
 * **行頭に固定すると「書いてあるのに書いていない」になる**（**そこが `listed` 0 件へ
 * 落ちると、この口が消しに来た誤診がそのまま残る**）。
 *
 * **読む側は厳しいまま**（下の 2 つの正規表現）——**知らない書き方は
 * 「書かれているが読めない」へ落ちる。** **書式が増えても、そこに穴は開かない。**
 */
function lineOf(config: string, key: string): string | undefined {
  return config.split("\n").find((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
}

/**
 * 設定に書かれているとおりの並び（`site_url` と `additional_redirect_urls`）。
 *
 * **`**` を含んだまま返す**——**GoTrue が突き合わせるのはこの形**である。
 *
 * **書いていないのと、読めないのを分ける** (#469)。
 *
 * - **鍵が無い** → **`listed`**（**GoTrue の既定に従うだけ**。**読めた側**である）
 * - **鍵はあるが、この形で読めない** → **`unreadable`**（**折り返した配列、
 *   行の後ろの注釈、`'` で囲んだ値**）
 * - **形に当たって中身が空** → **`listed` で 0 件**（**「読めた。1 つも許していない」**）
 *
 * **途中まで読めた結果を返さない**——**許可一覧が黙って短くなる**と、
 * **ログインできるホストが減り**、**理由は「許可されていない host」に化ける**
 * （#453 で分けたのは、まさにこれ）。
 *
 * **複数行を読めるようにはしない。** **そこまでやるなら、`#` の注釈・要素の中の `]`・
 * 行をまたぐ引用符まで面倒を見ることになる**——**この一覧は開発用の 1 ファイル**で、
 * **本番は `AUTH_ALLOWED_ORIGINS` が正**である（#453）。**読めないと言えば足りる。**
 */
export function allowedRedirectPatterns(path = configPath()): AllowedRedirects<string> {
  let config: string;
  try {
    config = readFileSync(path, "utf8");
  } catch {
    return { kind: "unreadable", source: path };
  }
  const siteLine = lineOf(config, "site_url");
  const additionalLine = lineOf(config, "additional_redirect_urls");
  const site =
    siteLine === undefined ? undefined : /^\s*site_url\s*=\s*"([^"]*)"\s*$/.exec(siteLine);
  const additional =
    additionalLine === undefined
      ? undefined
      : /^\s*additional_redirect_urls\s*=\s*\[(.*)\]\s*$/.exec(additionalLine);
  const body = additional?.[1];
  if (
    (siteLine !== undefined && site === null) ||
    (additionalLine !== undefined && additional === null) ||
    (body !== undefined && !fullyQuoted(body))
  ) {
    return { kind: "unreadable", source: path };
  }
  return {
    kind: "listed",
    listed: [
      ...(site?.[1] === undefined ? [] : [site[1]]),
      ...(body === undefined ? [] : quoted(body)),
    ],
  };
}

/** 1 行から、オリジンだけを取り出す。**取り出せなければ `undefined`。** */
function originOf(pattern: string): string | undefined {
  try {
    // **`*` を含む host は数えない**——**`http://*.example.com` をオリジンとして
    // 許すと、当たる先が広がる**
    const url = new URL(pattern.trim().replace(/\*+$/, ""));
    // **http / https だけを、オリジンとして扱う** (#478)。**それ以外の scheme は
    // `origin` が文字列 `"null"` になる**（`htp://localhost:3940` のような打ち間違い）
    // ——**そのまま一覧へ入れると、突き合わせる側が `new URL("null")` で落ちる**
    // （**画面には理由が出ない**）。**戻り先はブラウザが開く先**なので、
    // **この 2 つ以外は、こちらが言い表せる形ではない。**
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
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
  // **1 本でもオリジンにできなければ、全体を「読めない」とする** (#478)。
  //
  // **前は、その 1 本だけ落として続けていた**——**一覧が黙って短くなり**、
  // **その画面からのログインが「許可されていない host」で落ちる**（**設定は書いて
  // あるので、読んだ人は疑わない**）。**#469 / #477 が書式の側で消したのと同じ誤診**
  // である。
  //
  // **「許す側へ倒さない」は動かしていない。** **落とす以外の選択肢は `unreadable`**
  // であって、**許すことではない**——**`*` を含む host も、通さず、黙って落とさず、
  // 「読めない」と言う**（**GoTrue は当てられるが、こちらはオリジンとして言い表せない**）。
  //
  // **`suppliedOrigins`（実行時に渡された一覧）と、同じ方針である**——**設定ファイルには
  // GoTrue の書式がそのまま並ぶ**が、**この口が答えるのは「戻ってよいオリジン」**なので、
  // **言い表せない行が混ざった一覧は、短くして返すより読めないと言うほうが正しい。**
  const origins = new Set<string>();
  for (const pattern of patterns.listed) {
    const origin = originOf(pattern);
    if (origin === undefined) {
      return { kind: "unreadable", source: path };
    }
    origins.add(origin);
  }
  return { kind: "listed", listed: [...origins] };
}
