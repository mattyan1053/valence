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

import { afterEach, describe, expect, it, vi } from "vitest";
import { allowedRedirectOrigins } from "./redirect-allowlist";

afterEach(() => {
  vi.unstubAllEnvs();
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

  it("空で渡されたら、読めなかったとして返す", () => {
    // **「渡したのに 1 つも許されない」を、黙って通さない**
    vi.stubEnv("AUTH_ALLOWED_ORIGINS", "   ");

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
