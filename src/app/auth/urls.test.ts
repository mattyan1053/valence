/**
 * **戻り先を外から受けないこと**を見る。
 *
 * **クエリで受けると、そこが開いた転送になる**——**認可のコードを別のホストへ
 * 渡せてしまう。** **開いたオリジンからだけ組み立てる。**
 *
 * **`request.url` は「開いたオリジン」ではない**（#451）。**dev サーバは
 * `--hostname 0.0.0.0` で待ち受けている**ので、**`127.0.0.1:3000` から叩いても
 * `request.url` は `http://0.0.0.0:3000/…`** になる——**GoTrue の許可一覧に
 * 当たらず、`site_url` へ落ちて `/auth/callback` が呼ばれない**（実測）。
 *
 * **この試験も、同じ理由で緑だった。** **`new Request("http://localhost:3000/…")` は
 * 自分でオリジンを渡している**ので、**実物が組む形を 1 度も通っていない。**
 * **待ち受けアドレスを入れた入力を置く。**
 */

import { describe, expect, it } from "vitest";
import type { AllowedRedirects } from "../../composition/auth";
import { callbackUrl, homeUrl, loginUrl, originFrom } from "./urls";

/** **実物が組む形。** **待ち受けアドレスが `url` に入り、開いた先は `Host` にある。** */
function requestFrom(host: string, listeningOn = "0.0.0.0:3000"): Request {
  return new Request(`http://${listeningOn}/auth/login`, { headers: { host } });
}

describe("この App 自身の URL", () => {
  it("待ち受けアドレスではなく、開いたオリジンで組む", () => {
    // **これが #451 そのもの**である
    const request = requestFrom("127.0.0.1:3000");

    expect(callbackUrl(request)).toBe("http://127.0.0.1:3000/auth/callback");
    expect(loginUrl(request)).toBe("http://127.0.0.1:3000/auth/login");
    expect(homeUrl(request)).toBe("http://127.0.0.1:3000/");
  });

  it("localhost で開いたら、そちらのまま組み立てる", () => {
    // **`localhost` と `127.0.0.1` は別オリジンで Cookie も共有されない**
    // ——**設定へ書き固めると、片方でだけログインが完了しない。**
    expect(callbackUrl(requestFrom("localhost:3000"))).toBe("http://localhost:3000/auth/callback");
  });

  it("許可されていない host は弾く", () => {
    // **`Host` は外から来る**——**そのまま戻り先にすると、開いた転送になる**
    // （**`NextResponse.redirect(homeUrl(request))` がそこへ送る**）。
    expect(() => callbackUrl(requestFrom("evil.example.com"))).toThrow();
    expect(() => homeUrl(requestFrom("evil.example.com"))).toThrow();
    expect(() => loginUrl(requestFrom("evil.example.com"))).toThrow();
  });

  it("プロキシごしなら、そちらの host を見る", () => {
    // **`X-Forwarded-Host` も外から来る**ので、**同じ一覧で照合する。**
    const request = new Request("http://0.0.0.0:3000/auth/login", {
      headers: { host: "0.0.0.0:3000", "x-forwarded-host": "localhost:3000" },
    });

    expect(callbackUrl(request)).toBe("http://localhost:3000/auth/callback");
  });

  it("クエリで戻り先を差し込まれても、そこへは戻さない", () => {
    const request = new Request(
      "http://0.0.0.0:3000/auth/login?redirect=https://evil.example.com",
      {
        headers: { host: "localhost:3000" },
      },
    );

    for (const url of [callbackUrl(request), loginUrl(request), homeUrl(request)]) {
      expect(url.startsWith("http://localhost:3000/"), url).toBe(true);
    }
  });
});

/**
 * **読めなかったことを、「1 つも許していない」と混ぜない**（#453 のレビュー）。
 *
 * **この設定は開発のもの**で、**本番の口に置かれる保証が無い**——**混ぜると、
 * 本番で誰もログインできないのに、理由が「許可されていない host」になる。**
 * **`bin/doctor` の `[分かりません]` と同じ側**である。
 */
describe("許可一覧を読めなかったとき", () => {
  const request = new Request("http://0.0.0.0:3000/auth/login", {
    headers: { host: "localhost:3000" },
  });

  it("読めなかった、と言う", () => {
    const unreadable: AllowedRedirects<string> = {
      kind: "unreadable",
      source: "/どこにも無い/config.toml",
    };

    expect(() => originFrom(request, unreadable)).toThrow(/読めません/);
  });

  it("1 つも許していないのとは、別の言い方をする", () => {
    // **同じ文言だと、読んだ人は `config.toml` の中身を疑う**
    // ——**実際は、ファイルがそこに無い。**
    const empty: AllowedRedirects<string> = { kind: "listed", listed: [] };

    expect(() => originFrom(request, empty)).toThrow(/許可されていない host/);
    expect(() => originFrom(request, empty)).not.toThrow(/読めません/);
  });
});
