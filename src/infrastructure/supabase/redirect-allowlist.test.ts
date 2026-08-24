/**
 * **実行時に渡された許可一覧を読む**（#453 のレビュー）。
 *
 * **`supabase/config.toml` は開発のもの**である——**本番の Vercel には置かれず、
 * 置かれていても中身は `localhost`** なので、**そこだけを読むと、本番では
 * 誰もログインできない**（**戻り先が 1 つも当たらない**）。
 *
 * **正は「この配備がしゃべる GoTrue の一覧」である。** **開発ではそれが
 * `supabase/config.toml` で、本番では Supabase の設定**——**どちらか一方だけが
 * 効く**ので、**同じものが 2 箇所にある状態にはならない。**
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allowedRedirectOrigins, allowedRedirectPatterns } from "./redirect-allowlist";

const sandboxes: string[] = [];

/** 使い捨ての設定ファイル。**書式そのものを入力に置く。** */
function configWith(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "redirect-allowlist-"));
  sandboxes.push(dir);
  const path = join(dir, "config.toml");
  writeFileSync(path, body);
  return path;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 開発の設定（`localhost` だけが入っている）。 */
const DEV_CONFIG = "supabase/config.toml";

describe("実行時に渡された許可一覧", () => {
  it("渡されていたら、設定ファイルより先に使う", () => {
    vi.stubEnv("AUTH_ALLOWED_ORIGINS", "https://valence.example, https://www.valence.example");

    const allowed = allowedRedirectOrigins(DEV_CONFIG);

    expect(allowed).toEqual({
      kind: "listed",
      listed: ["https://valence.example", "https://www.valence.example"],
    });
  });

  it("パスが付いていても、オリジンだけを見る", () => {
    vi.stubEnv("AUTH_ALLOWED_ORIGINS", "https://valence.example/auth/callback");

    expect(allowedRedirectOrigins(DEV_CONFIG)).toEqual({
      kind: "listed",
      listed: ["https://valence.example"],
    });
  });

  it("オリジンにならない行が混じっていたら、読めなかったとして返す", () => {
    // **落とすと、渡したつもりの 1 本が黙って消える**——**当たらない理由が
    // 「許可されていない host」に化ける**（#453 で直したのと同じ向き）
    vi.stubEnv("AUTH_ALLOWED_ORIGINS", "https://valence.example, valence.example");

    expect(allowedRedirectOrigins(DEV_CONFIG)).toEqual({
      kind: "unreadable",
      source: "AUTH_ALLOWED_ORIGINS",
    });
  });

  it("host に `*` が入っていたら、読めなかったとして返す", () => {
    // **当たる先が広がる**——**黙って広げるより、渡し直させる**
    vi.stubEnv("AUTH_ALLOWED_ORIGINS", "https://*.valence.example");

    expect(allowedRedirectOrigins(DEV_CONFIG)).toEqual({
      kind: "unreadable",
      source: "AUTH_ALLOWED_ORIGINS",
    });
  });

  it("空で渡されたら、渡されていないものとして扱う", () => {
    // **`.env.example` を写すと、開発では空のまま渡る** (#453 のレビュー 2 周目)
    // ——**「空で定義されている」と「定義されていない」は見分けられない**ので、
    // **見分けられないほうへ倒さない**（**倒すと、写しただけの開発環境で
    // ログインが落ちる**）
    vi.stubEnv("AUTH_ALLOWED_ORIGINS", "   ");

    const allowed = allowedRedirectOrigins(DEV_CONFIG);

    expect(allowed.kind, "空を「渡された」と読んでいる").toBe("listed");
    expect(allowed.kind === "listed" ? allowed.listed : []).toContain("http://localhost:3000");
  });

  it("区切りだけが渡されたら、読めなかったとして返す", () => {
    // **空とは別である**——**何か書いてあるのに 1 つも取れない**ので、
    // **黙って設定ファイルへ落ちない**（**渡したつもりが効いていない**）
    vi.stubEnv("AUTH_ALLOWED_ORIGINS", ",,");

    expect(allowedRedirectOrigins(DEV_CONFIG)).toEqual({
      kind: "unreadable",
      source: "AUTH_ALLOWED_ORIGINS",
    });
  });

  it("渡されていなければ、設定ファイルを読む", () => {
    const allowed = allowedRedirectOrigins(DEV_CONFIG);

    expect(allowed.kind).toBe("listed");
    expect(allowed.kind === "listed" ? allowed.listed : []).toContain("http://localhost:3000");
  });

  it("渡されておらず、設定ファイルも無ければ、読めなかったところを言う", () => {
    const allowed = allowedRedirectOrigins("supabase/存在しない.toml");

    expect(allowed).toEqual({ kind: "unreadable", source: "supabase/存在しない.toml" });
  });
});

describe("設定の書式が読めないとき", () => {
  /**
   * **「読めなかった」を「1 つも許していない」と混ぜない**（#469）。
   *
   * **#453 でその 2 つを分けた**のに、**書式の側が漏れていた**——**折り返して書くと
   * 当たらず、`listed` で 0 件を返す。** **倒れる向きは拒否側**（ログインが落ちる）だが、
   * **理由が「許可されていない host」に化ける**ので、**読んだ人は設定を疑わない。**
   */
  it("折り返した配列は、読めなかったとして返す", () => {
    const path = configWith(
      [
        "[auth]",
        'site_url = "http://localhost:3000"',
        "additional_redirect_urls = [",
        '  "http://localhost:3000/**",',
        "]",
        "",
      ].join("\n"),
    );

    expect(allowedRedirectPatterns(path)).toEqual({ kind: "unreadable", source: path });
  });

  it("`site_url` が読めない書き方でも、読めなかったとして返す", () => {
    // **片方だけ直さない**（#469 の条件）——**同じ鍵の話**である
    const path = configWith(["[auth]", "site_url = 'http://localhost:3000'", ""].join("\n"));

    expect(allowedRedirectPatterns(path)).toEqual({ kind: "unreadable", source: path });
  });

  it("行の後ろに注釈が付いていても、読めなかったとして返す", () => {
    // **黙って落とさない**——**前は `\]\s*$` に当たらず、その 1 行がまるごと消えた**
    const path = configWith(
      ["[auth]", 'additional_redirect_urls = ["http://localhost:3000/**"] # 開発用', ""].join("\n"),
    );

    expect(allowedRedirectPatterns(path)).toEqual({ kind: "unreadable", source: path });
  });

  it("この形で読めない要素が混じっていたら、読めなかったとして返す", () => {
    // **外側は当たるが、中身が全部は読めない** (#469 のレビュー)——**`'` で囲んだ要素は
    // TOML として有効**である。**拾える側だけ返すと、一覧が黙って短くなり**、
    // **ログインの失敗が「許可されていない host」に化ける**（**この PR が消しに来た形**）。
    const path = configWith(
      [
        "[auth]",
        `additional_redirect_urls = ["http://localhost:3000/**", 'http://127.0.0.1:3000/**']`,
        "",
      ].join("\n"),
    );

    expect(allowedRedirectPatterns(path)).toEqual({ kind: "unreadable", source: path });
  });

  it("この形で読めない要素だけなら、0 件ではなく読めなかったとして返す", () => {
    const path = configWith(
      ["[auth]", `additional_redirect_urls = ['http://localhost:3000/**']`, ""].join("\n"),
    );

    expect(allowedRedirectPatterns(path)).toEqual({ kind: "unreadable", source: path });
  });

  it("末尾のカンマは、これまでどおり読める", () => {
    // **TOML では書ける形**である——**読める書式を、読めない側へ倒さない**
    const path = configWith(
      ["[auth]", 'additional_redirect_urls = ["http://localhost:3000/**",]', ""].join("\n"),
    );

    expect(allowedRedirectPatterns(path)).toEqual({
      kind: "listed",
      listed: ["http://localhost:3000/**"],
    });
  });

  it("鍵がインデントされていても、書かれている側として読む", () => {
    // **TOML は鍵の前に空白を置ける** (#469 のレビュー 3 周目)——**探す側が厳しいと、
    // 書いてあるのに「鍵が無い」へ落ち**、**この PR が足した 3 つ目の状態
    // （鍵が無い → 読めた側）が嘘になる。**
    const path = configWith(
      [
        "[auth]",
        '  site_url = "http://localhost:3000"',
        '\tadditional_redirect_urls = ["http://localhost:3000/**"]',
        "",
      ].join("\n"),
    );

    expect(allowedRedirectPatterns(path)).toEqual({
      kind: "listed",
      listed: ["http://localhost:3000", "http://localhost:3000/**"],
    });
  });

  it("インデントされていても、値が読めなければ読めなかったとして返す", () => {
    // **探す側はゆるく、読む側は厳しく**——**知らない書き方は
    // 「書かれているが読めない」へ落ちる**（**「書かれていない」ではない**）
    const path = configWith(["[auth]", "  site_url = 'http://localhost:3000'", ""].join("\n"));

    expect(allowedRedirectPatterns(path)).toEqual({ kind: "unreadable", source: path });
  });

  it("空文字の要素は、読めた側である", () => {
    // **「読める」の定義を 1 つにする**——**中身を確かめる側（`fullyQuoted`）と
    // 取り出す側（`quoted`）で、空文字の扱いが食い違っていた。**
    // **何にも当たらないパターン**なので、**オリジンとしては数えない。**
    const path = configWith(["[auth]", 'additional_redirect_urls = [""]', ""].join("\n"));

    expect(allowedRedirectPatterns(path)).toEqual({ kind: "listed", listed: [""] });
    // **オリジンにはならない**ので、**そちらの口は「読めない」と言う** (#478)
    expect(allowedRedirectOrigins(path)).toEqual({ kind: "unreadable", source: path });
  });

  it("鍵が無いのは、読めなかったではない", () => {
    // **書いていないものは、読めなかったのではない**——**GoTrue の既定に従うだけ**である
    const path = configWith(["[auth]", "enabled = true", ""].join("\n"));

    expect(allowedRedirectPatterns(path)).toEqual({ kind: "listed", listed: [] });
  });

  it("空の配列は、これまでどおり「読めた。1 つも許していない」", () => {
    const path = configWith(["[auth]", "additional_redirect_urls = []", ""].join("\n"));

    expect(allowedRedirectPatterns(path)).toEqual({ kind: "listed", listed: [] });
  });

  it("1 行で書いてあれば、これまでどおり読む", () => {
    const path = configWith(
      [
        "[auth]",
        'site_url = "http://localhost:3000"',
        'additional_redirect_urls = ["http://localhost:3000/**", "http://127.0.0.1:3000/**"]',
        "",
      ].join("\n"),
    );

    expect(allowedRedirectPatterns(path)).toEqual({
      kind: "listed",
      listed: ["http://localhost:3000", "http://localhost:3000/**", "http://127.0.0.1:3000/**"],
    });
  });
});

describe("オリジンにならない行があるとき", () => {
  /**
   * **一覧が黙って短くなると、その画面からのログインが「許可されていない host」で
   * 落ちる**（#478）——**設定は書いてあるので、読んだ人は疑わない。**
   *
   * **「許す側へ倒さない」は動かさない。** **落とす以外の選択肢は `unreadable`**
   * であって、**許すことではない。**
   */
  it("1 本でもオリジンにならなければ、読めなかったとして返す", () => {
    const path = configWith(
      [
        "[auth]",
        'additional_redirect_urls = ["http://localhost:3000/**", "htp://localhost:3940/**"]',
        "",
      ].join("\n"),
    );

    expect(allowedRedirectOrigins(path)).toEqual({ kind: "unreadable", source: path });
  });

  it("host に `*` を含む行も、黙って落とさない", () => {
    // **GoTrue は当てられるが、こちらはオリジンとして言い表せない**——**通せば
    // 当たる先が広がり**、**落とせば一覧が黙って短くなる。** **どちらでもなく、
    // 「読めない」と言う。**
    const path = configWith(
      ["[auth]", 'additional_redirect_urls = ["https://*.example.com/**"]', ""].join("\n"),
    );

    expect(allowedRedirectOrigins(path)).toEqual({ kind: "unreadable", source: path });
  });

  it("`site_url` が空でも、読めなかったとして返す", () => {
    // **形は読めて、オリジンにならない**（#478）
    const path = configWith(["[auth]", 'site_url = ""', ""].join("\n"));

    expect(allowedRedirectOrigins(path)).toEqual({ kind: "unreadable", source: path });
  });

  it("全部オリジンになるなら、これまでどおり並べる", () => {
    const path = configWith(
      [
        "[auth]",
        'site_url = "http://localhost:3000"',
        'additional_redirect_urls = ["http://localhost:3000/**", "http://127.0.0.1:3000/**"]',
        "",
      ].join("\n"),
    );

    expect(allowedRedirectOrigins(path)).toEqual({
      kind: "listed",
      listed: ["http://localhost:3000", "http://127.0.0.1:3000"],
    });
  });
});
