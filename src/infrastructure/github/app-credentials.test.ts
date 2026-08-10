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
