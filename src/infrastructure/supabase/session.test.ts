/**
 * **ブラウザが行く先と、サーバが叩く先は別である。**
 *
 * **開発では docker の中と外で名前が違う**（`compose.yaml`）——**片方へ寄せると、
 * どちらへ寄せても通らない。** `localhost:54321` にすると **app コンテナが自分自身を
 * 叩き**、`kong:8000` にすると **ブラウザが `kong` を解決できない。**
 */

import { describe, expect, it } from "vitest";
import { readSupabaseConnection, toBrowserUrl } from "./session";

const ENV = {
  SUPABASE_URL: "http://kong:8000",
  NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
};

describe("Supabase の繋ぎ先", () => {
  it("サーバ側とブラウザ側を、別々に読む", () => {
    const connection = readSupabaseConnection(ENV);

    expect(connection.serverUrl).toBe("http://kong:8000");
    expect(connection.publicUrl).toBe("http://localhost:54321");
  });

  it("片方でも欠けたら、入口で落とす", () => {
    // **足りないまま動かすと、症状は「コールバックが必ず失敗する」**——
    // **原因はどこにも出ない。**
    for (const missing of Object.keys(ENV)) {
      const env = { ...ENV, [missing]: "" };
      expect(() => readSupabaseConnection(env), missing).toThrow();
    }
  });

  it("値そのものを、失敗の文面へ載せない", () => {
    expect(() => readSupabaseConnection({ ...ENV, SUPABASE_URL: "" })).not.toThrow(
      /sb_publishable_test/,
    );
  });

  describe("ブラウザへ渡す URL", () => {
    const connection = readSupabaseConnection(ENV);

    it("サーバ側の名前で来たら、ブラウザ側の名前へ置き換える", () => {
      // **`signInWithOAuth` が作る URL は、クライアントを作ったときの繋ぎ先で始まる。**
      // **そのまま返すと、ブラウザは `kong` を解決できない。**
      expect(toBrowserUrl(connection, "http://kong:8000/auth/v1/authorize?provider=github")).toBe(
        "http://localhost:54321/auth/v1/authorize?provider=github",
      );
    });

    it("問い合わせと素片は落とさない", () => {
      // **`state` と PKCE の検証子はここに載っている**——**落とすと、
      // 戻ってきたときに突き合わせるものが無い。**
      expect(toBrowserUrl(connection, "http://kong:8000/auth/v1/authorize?a=1&b=2#frag")).toContain(
        "?a=1&b=2#frag",
      );
    });

    it("知らない行き先は、書き換えない", () => {
      // **置き換えるのは、自分が作った繋ぎ先だけ**である——
      // **何でも書き換えると、外から渡された URL の行き先を変えてしまう。**
      expect(toBrowserUrl(connection, "https://github.com/login/oauth/authorize")).toBe(
        "https://github.com/login/oauth/authorize",
      );
    });

    it("同じ繋ぎ先なら、そのまま返す", () => {
      // **本番は 1 つの URL で足りる。** **そのときに壊れないこと。**
      const same = readSupabaseConnection({
        ...ENV,
        SUPABASE_URL: "https://project.supabase.co",
        NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
      });
      expect(toBrowserUrl(same, "https://project.supabase.co/auth/v1/authorize")).toBe(
        "https://project.supabase.co/auth/v1/authorize",
      );
    });
  });
});
