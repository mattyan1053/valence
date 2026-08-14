/**
 * **戻り先を外から受けないこと**を見る。
 *
 * **クエリで受けると、そこが開いた転送になる**——**認可のコードを別のホストへ
 * 渡せてしまう。** **要求が来たオリジンからだけ組み立てる。**
 */

import { describe, expect, it } from "vitest";
import { callbackUrl, homeUrl, loginUrl } from "./urls";

function requestTo(url: string): Request {
  return new Request(url);
}

describe("この App 自身の URL", () => {
  it("要求が来たオリジンの上に組み立てる", () => {
    const request = requestTo("http://localhost:3000/auth/login");

    expect(callbackUrl(request)).toBe("http://localhost:3000/auth/callback");
    expect(loginUrl(request)).toBe("http://localhost:3000/auth/login");
    expect(homeUrl(request)).toBe("http://localhost:3000/");
  });

  it("127.0.0.1 で開いたら、そちらのまま組み立てる", () => {
    // **`localhost` と `127.0.0.1` は別オリジンで Cookie も共有されない**
    // ——**設定へ書き固めると、片方でだけログインが完了しない。**
    const request = requestTo("http://127.0.0.1:3000/auth/login");

    expect(callbackUrl(request)).toBe("http://127.0.0.1:3000/auth/callback");
  });

  it("クエリで戻り先を差し込まれても、そこへは戻さない", () => {
    const request = requestTo("http://localhost:3000/auth/login?redirect=https://evil.example.com");

    for (const url of [callbackUrl(request), loginUrl(request), homeUrl(request)]) {
      expect(url.startsWith("http://localhost:3000/"), url).toBe(true);
    }
  });
});
