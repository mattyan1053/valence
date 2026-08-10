/**
 * GitHub App として名乗るための JWT を組み立てる。
 *
 * **通信は要らない。** 秘密鍵と現在時刻だけで決まるので純粋関数として書ける。
 * installation token を取る要求の `Authorization` に載せる。
 */

import { createSign } from "node:crypto";
import type { AppCredentials } from "./app-credentials";

/**
 * **発行時刻を 60 秒戻す。** GitHub 側と時計がずれていると
 * 「未来に発行された JWT」として弾かれる（公式の推奨）。
 */
const CLOCK_SKEW_SECONDS = 60;

/** **GitHub は 10 分より先の `exp` を拒否する。** 戻した分も込みで収める。 */
const LIFETIME_SECONDS = 600 - CLOCK_SKEW_SECONDS;

/**
 * App の JWT を作る。
 *
 * **鍵が壊れていたら投げる**が、**そのとき鍵の中身を載せない**。
 * 失敗経路の文面はログに残るので、ここが一番危ない（`AGENTS.md` §6）。
 */
export function createAppJwt(
  credentials: Pick<AppCredentials, "appId" | "privateKey">,
  now: Date,
): string {
  const issuedAt = Math.floor(now.getTime() / 1000) - CLOCK_SKEW_SECONDS;
  const header = encode({ alg: "RS256", typ: "JWT" });
  const payload = encode({
    iss: credentials.appId,
    iat: issuedAt,
    exp: issuedAt + LIFETIME_SECONDS,
  });

  return `${header}.${payload}.${sign(`${header}.${payload}`, credentials.privateKey)}`;
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function sign(signingInput: string, privateKey: string): string {
  try {
    return createSign("RSA-SHA256").update(signingInput).sign(privateKey, "base64url");
  } catch {
    // **元の例外を持ち上げない。** メッセージに鍵の断片が入りうる
    throw new Error("GitHub App の秘密鍵で署名できませんでした");
  }
}
