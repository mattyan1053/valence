import { describe, expect, it } from "vitest";
import { readAppCredentials } from "./app-credentials";

/** `.env` に入る形（PEM は 1 行に潰して `\n` でエスケープする）。 */
const env = {
  GITHUB_APP_ID: "1234",
  GITHUB_APP_INSTALLATION_ID: "5678",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nMIIE\\n-----END PRIVATE KEY-----\\n",
};

describe("GitHub App の資格情報を読む", () => {
  it("環境変数から読む", () => {
    const credentials = readAppCredentials(env);

    expect(credentials.appId).toBe("1234");
    expect(credentials.installationId).toBe("5678");
  });

  it("1 行に潰された PEM を改行へ戻す", () => {
    // **`.env` は改行を持てない。** 戻さないと署名が通らず、症状は 401 になる
    const { privateKey } = readAppCredentials(env);

    expect(privateKey).toBe("-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n");
  });

  it("すでに改行を含む PEM はそのまま扱う", () => {
    const { privateKey } = readAppCredentials({
      ...env,
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n",
    });

    expect(privateKey).toBe("-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n");
  });

  it("欠けている変数があれば、その名前を挙げて投げる", () => {
    // **空文字のまま進めない。** 進めると症状が 401 になり、設定漏れだと分からない
    expect(() => readAppCredentials({ ...env, GITHUB_APP_ID: undefined })).toThrow(/GITHUB_APP_ID/);
    expect(() => readAppCredentials({ ...env, GITHUB_APP_PRIVATE_KEY: "" })).toThrow(
      /GITHUB_APP_PRIVATE_KEY/,
    );
  });

  it("空白だけの値は未設定と同じに扱う", () => {
    // **`!== ""` では通ってしまう。** 通すと `iss` や URL に空白が載り、
    // 症状が 401 / 404 になって**設定ミスだと分からなくなる**
    expect(() => readAppCredentials({ ...env, GITHUB_APP_ID: " " })).toThrow(/GITHUB_APP_ID/);
    expect(() => readAppCredentials({ ...env, GITHUB_APP_INSTALLATION_ID: "  " })).toThrow(
      /GITHUB_APP_INSTALLATION_ID/,
    );
    expect(() => readAppCredentials({ ...env, GITHUB_APP_PRIVATE_KEY: " \n " })).toThrow(
      /GITHUB_APP_PRIVATE_KEY/,
    );
  });

  it("ID が数字でなければ落とす", () => {
    // App ID も installation ID も **GitHub が振る数値**である。
    // URL に載ってから 404 で気づくのでは、設定ミスだと分からない
    expect(() => readAppCredentials({ ...env, GITHUB_APP_ID: "my-app" })).toThrow(/GITHUB_APP_ID/);
    expect(() => readAppCredentials({ ...env, GITHUB_APP_INSTALLATION_ID: "56 78" })).toThrow(
      /GITHUB_APP_INSTALLATION_ID/,
    );
  });

  it("ID の前後の空白は落として使う", () => {
    // `.env` を手で編集すると混ざる。**中身が数字なら設定ミスではない**
    expect(readAppCredentials({ ...env, GITHUB_APP_ID: " 1234 " }).appId).toBe("1234");
  });

  it("秘密鍵の中身までは見ない", () => {
    // **PEM の形を検証しない。** 署名が通るかは通してみるのが確実で、
    // ここで形を見に行っても二重に持つだけになる
    expect(() =>
      readAppCredentials({ ...env, GITHUB_APP_PRIVATE_KEY: "これは鍵ではない" }),
    ).not.toThrow();
  });

  it("投げるときに値を載せない", () => {
    // **名前は出してよいが、値は出さない。** 秘密鍵が入っている変数もここを通る
    const secret = "-----BEGIN PRIVATE KEY-----leaked-----END PRIVATE KEY-----";

    try {
      readAppCredentials({ ...env, GITHUB_APP_ID: "", GITHUB_APP_PRIVATE_KEY: secret });
      expect.unreachable("欠けているのに通ってしまった");
    } catch (error) {
      expect(String(error)).not.toContain("leaked");
    }
  });
});
