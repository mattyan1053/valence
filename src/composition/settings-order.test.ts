/**
 * **`process.env` だけで決まるものは、交換より先に読むこと** (#224 のレビュー)。
 *
 * **交換が済んだ時点で、認証の Cookie は置かれている。** **そのあとで設定の不備に
 * 気づくと、作りかけのセッションを畳む手間がひとつ増える**——**落ちる経路は、
 * 作らずに済むなら作らない。**
 *
 * **実際に踏んだ。** **鍵の読み取りが `completeLogin` の引数の位置にあった**ので、
 * **投げると `completeLogin` へ一度も入らず、畳む経路を通らなかった**——
 * **鍵が未設定なら、ログインのたびにセッションだけが残る。**
 *
 * **散文で「先に読む」と書くだけにしない。** **次に設定を 1 つ足した人が
 * 後ろへ書いたら、ここで赤くなる。**
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(fileURLToPath(new URL("./auth.ts", import.meta.url)), "utf8");

/** `completeGithubLogin` の中身だけを取り出す。**見たいのはこの順番**である。 */
function completeGithubLoginBody(): string {
  const start = SOURCE.indexOf("export async function completeGithubLogin");
  expect(start, "completeGithubLogin が見つからない").toBeGreaterThan(-1);
  const end = SOURCE.indexOf("\n}\n", start);
  expect(end, "関数の終わりが見つからない").toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

/** `settings()` の中身だけを取り出す。 */
function settingsBody(): string {
  const start = SOURCE.indexOf("function settings()");
  expect(start, "settings() が見つからない").toBeGreaterThan(-1);
  const end = SOURCE.indexOf("\n}\n", start);
  expect(end, "関数の終わりが見つからない").toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

/** `process.env` だけで決まる読み取り。**足したらここにも足す。** */
const ENV_ONLY_READS = ["readOAuthCredentials", "readSupabaseConnection", "readEncryptionKey"];

describe("設定を読む順番", () => {
  it("`process.env` だけで決まるものは、1 箇所にまとまっている", () => {
    // **散らばっていると、次の 1 つが別の場所へ書かれる**——**そこが交換より
    // 後ろだと、また同じ穴が開く。**
    const grouped = settingsBody();
    for (const name of ENV_ONLY_READS) {
      expect(grouped, `${name} が settings() の外にある`).toContain(`${name}(process.env)`);
      const occurrences = SOURCE.split(`${name}(process.env)`).length - 1;
      expect(occurrences, `${name} を呼ぶ場所が 1 つではない`).toBe(1);
    }
  });

  it("その 1 箇所を、交換より先に通る", () => {
    const body = completeGithubLoginBody();
    const read = body.indexOf("settings()");
    const exchange = body.indexOf("exchangeCodeForProviderTokens");
    expect(read, "settings() を呼んでいない").toBeGreaterThan(-1);
    expect(exchange, "交換の呼び出しが見つからない").toBeGreaterThan(-1);
    expect(read, "設定の読み取りが交換より後に来ている").toBeLessThan(exchange);
  });

  it("ログインの経路は、App の資格を要求しない", () => {
    // **一緒に読むと、鍵が置かれていない環境ではログインまで落ちる** (#314)
    // ——**症状は「盤面が出ない」ではなく「入れない」**になり、
    // **原因から最も遠い場所で止まる。** **読む場所は 1 つのまま分けておく。**
    expect(settingsBody(), "App の資格が settings() に入っている").not.toContain(
      "readAppCredentials",
    );
    expect(completeGithubLoginBody(), "ログインが App の資格を読んでいる").not.toContain(
      "readAppCredentials",
    );
    const occurrences = SOURCE.split("readAppCredentials(process.env)").length - 1;
    expect(occurrences, "App の資格を読む場所が 1 つではない").toBe(1);
  });

  it("置き場は、開く手続きごと渡す", () => {
    // **開いた結果だけを渡すと、開く手前で落ちたときに `completeLogin` へ入らない**
    // ——**畳む経路が、その 1 本にだけ効かなくなる。**
    const body = completeGithubLoginBody();
    expect(body).toContain("openStore:");
    expect(body, "開いた結果を渡している").not.toMatch(/store:\s*await\s/);
  });
});
