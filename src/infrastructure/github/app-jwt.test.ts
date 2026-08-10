import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAppJwt } from "./app-jwt";

/** **本物の鍵は使わない。** 検証のためだけにその場で作る（秘密鍵はコミットしない）。 */
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const now = new Date("2026-08-10T00:00:00Z");
const nowInSeconds = Math.floor(now.getTime() / 1000);

function decode(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

function partsOf(jwt: string): [string, string, string] {
  const parts = jwt.split(".");
  expect(parts).toHaveLength(3);
  return parts as [string, string, string];
}

describe("GitHub App の JWT", () => {
  it("RS256 で署名した 3 つの部分になる", () => {
    const [header] = partsOf(createAppJwt({ appId: "1234", privateKey }, now));

    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
  });

  it("秘密鍵に対応する公開鍵で検証できる", () => {
    // **署名しているか**を見る。形だけ整っていても GitHub は 401 を返す
    const jwt = createAppJwt({ appId: "1234", privateKey }, now);
    const [header, payload, signature] = partsOf(jwt);

    const verify = createVerify("RSA-SHA256").update(`${header}.${payload}`);

    expect(verify.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("発行者は App ID", () => {
    const [, payload] = partsOf(createAppJwt({ appId: "1234", privateKey }, now));

    expect(decode(payload)).toMatchObject({ iss: "1234" });
  });

  it("発行時刻を少し過去にする", () => {
    // **GitHub 側と時計がずれていると「未来に発行された JWT」として弾かれる。**
    // 公式の推奨どおり 60 秒戻す
    const [, payload] = partsOf(createAppJwt({ appId: "1234", privateKey }, now));

    expect(decode(payload)).toMatchObject({ iat: nowInSeconds - 60 });
  });

  it("有効期限は 10 分を超えない", () => {
    // **GitHub は 10 分より先の exp を拒否する。** iat を戻した分も込みで収める
    const [, payload] = partsOf(createAppJwt({ appId: "1234", privateKey }, now));
    const claims = decode(payload) as { iat: number; exp: number };

    expect(claims.exp).toBeGreaterThan(nowInSeconds);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
  });

  it("鍵が壊れていたら投げる。そのとき鍵の中身を漏らさない", () => {
    // **失敗経路が一番危ない。** 例外の文面に鍵が混ざると、ログに残る
    const secret = "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----";

    try {
      createAppJwt({ appId: "1234", privateKey: secret }, now);
      expect.unreachable("壊れた鍵でも通ってしまった");
    } catch (error) {
      expect(String(error)).not.toContain("not-a-real-key");
    }
  });
});
