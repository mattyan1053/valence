/**
 * **盤面へ戻す先は、開いたオリジンの上に組む**（#506。#451 と同じ形）。
 *
 * **`request.url` はブラウザが使ったオリジンではない**——**dev サーバは
 * `--hostname 0.0.0.0` で待ち受けている**ので、**`127.0.0.1:3940` から押しても
 * `request.url` は `http://0.0.0.0:3000/…`** になる。**そこへ戻すと
 * `ERR_ADDRESS_INVALID` で終わる**（**利用者の実測**）。
 *
 * **#451 は同じことを `src/app/auth/urls.ts` で直した。** **同じ形が
 * こちらに残っていた**——**判定は 1 箇所に置く**（`originFrom`）。
 */

import { afterEach, describe, expect, it } from "vitest";
import { boardRedirect } from "./board-redirect";

const SUPPLIED = "AUTH_ALLOWED_ORIGINS";
const before = process.env[SUPPLIED];

afterEach(() => {
  if (before === undefined) {
    delete process.env[SUPPLIED];
  } else {
    process.env[SUPPLIED] = before;
  }
});

/** **待ち受けアドレスと、開いたオリジンが違う要求**（**踏む形**）。 */
function pressedFrom(host: string): Request {
  return new Request("http://0.0.0.0:3000/repos/acme/web/approve", {
    method: "POST",
    headers: { host },
  });
}

describe("盤面へ戻す先を、開いたオリジンから組む", () => {
  it("待ち受けアドレスではなく、開いたオリジンへ戻す", () => {
    process.env[SUPPLIED] = "http://127.0.0.1:3940";

    const response = boardRedirect(
      pressedFrom("127.0.0.1:3940"),
      { owner: "acme", name: "web" },
      {
        param: "approve",
        value: "forbidden",
      },
    );

    expect(response.headers.get("location")).toBe(
      "http://127.0.0.1:3940/repos/acme/web?approve=forbidden",
    );
  });

  it("許可されていない host なら、組み立てない", () => {
    // **`Host` は外から来る** (#451)——**そのまま戻り先にすると、開いた転送になる。**
    process.env[SUPPLIED] = "http://127.0.0.1:3940";

    expect(() =>
      boardRedirect(pressedFrom("evil.example.com"), { owner: "acme", name: "web" }, undefined),
    ).toThrow(/許可されていない host/);
  });

  it("一覧を読めないことを、「1 つも許していない」と言わない", () => {
    // **#453 で分けた側**——**混ぜると、渡し忘れの理由が「許可されていない host」に化ける。**
    process.env[SUPPLIED] = ",,";

    expect(() =>
      boardRedirect(pressedFrom("127.0.0.1:3940"), { owner: "acme", name: "web" }, undefined),
    ).toThrow(/読めません/);
  });
});
