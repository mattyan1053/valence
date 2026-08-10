import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AppCredentials } from "./app-credentials";
import { needsRefresh, requestInstallationToken, tokenRequestError } from "./installation-token";

const now = new Date("2026-08-10T00:00:00Z");

/** **本物の鍵は使わない。** 署名できる形が要るだけなので、その場で作る。 */
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const credentials: AppCredentials = { appId: "1234", installationId: "5678", privateKey };

/**
 * **`fetch` を引数で受けて差し替える。** `vi.stubGlobal` を使わないのは、
 * 引数で渡せるものを大域の差し替えで解くのは「最後の手段」ではないため（§4）。
 */
function respondingWith(body: string, status = 201): typeof fetch {
  return () => Promise.resolve(new Response(body, { status }));
}

function recordingFetch(): { calls: Request[]; fetchImpl: typeof fetch } {
  const calls: Request[] = [];
  return {
    calls,
    fetchImpl: (input, init) => {
      calls.push(new Request(input, init));
      return Promise.resolve(
        new Response('{"token":"ghs_ok","expires_at":"2026-08-10T01:00:00Z"}', { status: 201 }),
      );
    },
  };
}

function expiringIn(seconds: number) {
  return { token: "ghs_dummy", expiresAt: new Date(now.getTime() + seconds * 1000) };
}

describe("installation token を取り直すか", () => {
  it("まだ持っていなければ取る", () => {
    expect(needsRefresh(undefined, now)).toBe(true);
  });

  it("期限が切れていれば取り直す", () => {
    // **切れた token をそのまま使うと 401 になり、権限の問題と見分けがつかない**
    expect(needsRefresh(expiringIn(-1), now)).toBe(true);
  });

  it("期限ちょうどでも取り直す", () => {
    expect(needsRefresh(expiringIn(0), now)).toBe(true);
  });

  it("期限が間近なら取り直す", () => {
    // **通信の途中で切れうる。** 残り時間が処理時間を下回ると、
    // 「取れているのに 401」という一番分かりにくい形で出る
    expect(needsRefresh(expiringIn(30), now)).toBe(true);
  });

  it("十分に残っていれば使い回す", () => {
    // 毎回取り直すと、GitHub 側の制限に無駄に当たる
    expect(needsRefresh(expiringIn(3000), now)).toBe(false);
  });
});

describe("取得に失敗したときのエラー", () => {
  it("状態コードを載せる", () => {
    expect(tokenRequestError(401, "").message).toContain("401");
  });

  it("応答の中身を載せない", () => {
    // **エラー応答をそのまま出すと秘密が混ざりうる**（§6「出力に何が含まれうるかで判断する」）。
    // 実際、token を作る要求の応答には token そのものが入る
    const body = '{"token":"ghs_leaked","expires_at":"2026-08-10T01:00:00Z"}';

    expect(tokenRequestError(201, body).message).not.toContain("ghs_leaked");
  });
});

describe("installation token を取ってくる", () => {
  const success = '{"token":"ghs_ok","expires_at":"2026-08-10T01:00:00Z"}';

  it("成功した応答から token と期限を取り出す", async () => {
    const token = await requestInstallationToken(credentials, now, respondingWith(success));

    expect(token.token).toBe("ghs_ok");
    expect(token.expiresAt).toEqual(new Date("2026-08-10T01:00:00Z"));
  });

  it("installation の access_tokens へ POST する", async () => {
    // **黙って壊れるところ。** URL もメソッドも、間違えて初めて分かるのは実接続時になる
    const { calls, fetchImpl } = recordingFetch();
    await requestInstallationToken(credentials, now, fetchImpl);

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.github.com/app/installations/5678/access_tokens");
  });

  it("App の JWT を Bearer で載せる", async () => {
    // installation token は **App として署名した JWT** でしか取れない
    const { calls, fetchImpl } = recordingFetch();
    await requestInstallationToken(credentials, now, fetchImpl);
    const authorization = calls[0]?.headers.get("authorization") ?? "";

    expect(authorization.startsWith("Bearer ")).toBe(true);
    expect(authorization.slice("Bearer ".length).split(".")).toHaveLength(3);
  });

  it("断られたら投げる", async () => {
    await expect(
      requestInstallationToken(credentials, now, respondingWith('{"message":"Bad"}', 401)),
    ).rejects.toThrow(/401/);
  });

  it("応答が読めなければ、断られたのとは別の文面で投げる", async () => {
    // **「断られた」と「読めなかった」を潰さない。** 潰すと HTTP 200 で
    // 「取得できませんでした」と出て、原因がどちらか分からなくなる
    const rejected = await requestInstallationToken(
      credentials,
      now,
      respondingWith('{"message":"Bad"}', 401),
    ).catch((error: unknown) => String(error));
    const unreadable = await requestInstallationToken(
      credentials,
      now,
      respondingWith("not json", 201),
    ).catch((error: unknown) => String(error));

    expect(unreadable).not.toBe(rejected);
    expect(unreadable).toMatch(/読め/);
  });

  it("項目が欠けた応答も読めなかったものとして投げる", async () => {
    await expect(
      requestInstallationToken(credentials, now, respondingWith('{"token":"ghs_ok"}')),
    ).rejects.toThrow(/読め/);
  });

  it("投げるときに応答の中身を載せない", async () => {
    // **この要求の応答には token そのものが入る。** 失敗経路でも出さない
    const leaky = '{"token":"ghs_leaked","expires_at":"壊れた日付"}';

    const message = await requestInstallationToken(credentials, now, respondingWith(leaky)).catch(
      (error: unknown) => String(error),
    );

    expect(message).not.toContain("ghs_leaked");
  });
});
