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
