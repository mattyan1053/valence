import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken, readEncryptionKey } from "./token-cipher";

/**
 * **トークンを平文で置かない**（`AGENTS.md` §6）。
 *
 * **倒す先は 2 つある**（#210）。
 *
 * - **書けたのに読めない**（可逆でない・鍵の取り違え）
 * - **読めてはいけない人に読める**（ここでは**鍵を持たない側**）
 *
 * **片方だけ見ると、両方の向きで緑になる形が残る。**
 */
describe("トークンの暗号", () => {
  const key = readEncryptionKey({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") });
  const other = readEncryptionKey({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") });

  it("暗号化したものを、同じ鍵で戻せる", () => {
    // **戻せなければ、保存した時点で失われている**——**症状は「ログインし直しても
    // 直らない」**になり、**書けているぶん気づきにくい**
    expect(decryptToken(key, encryptToken(key, "ghu_secret"))).toBe("ghu_secret");
  });

  it("空でない中身は、そのまま残る（改行や記号も）", () => {
    const value = "ghr_a+b/c=\nd";

    expect(decryptToken(key, encryptToken(key, value))).toBe(value);
  });

  it("違う鍵では戻せない", () => {
    // **鍵の取り違えを、静かに素通りさせない**
    const sealed = encryptToken(key, "ghu_secret");

    expect(() => decryptToken(other, sealed)).toThrow(/復号できません/);
  });

  it("同じ中身でも、毎回違う暗号文になる", () => {
    // **決定的だと、DB を見るだけで「同じトークンを使い回している人」が分かる**
    // ——**中身を読めなくても、等しいことが漏れる**
    expect(encryptToken(key, "ghu_secret")).not.toBe(encryptToken(key, "ghu_secret"));
  });

  it("1 文字でも書き換えられていたら、戻さない", () => {
    // **改竄を検出できない暗号だと、書き換えた値をそのまま返す**
    const sealed = encryptToken(key, "ghu_secret");
    const flipped = `${sealed.slice(0, -2)}${sealed.at(-2) === "A" ? "B" : "A"}${sealed.at(-1)}`;

    expect(() => decryptToken(key, flipped)).toThrow(/復号できません/);
  });

  it("形の違うものを渡されても、戻さない", () => {
    // **DB の値は壊れうる**（移行の失敗、手で書き換え）——**平文として返さない**
    expect(() => decryptToken(key, "これは暗号文ではない")).toThrow(/復号できません/);
    expect(() => decryptToken(key, "")).toThrow(/復号できません/);
  });

  it("鍵が短ければ、使う前に落ちる", () => {
    // **短い鍵で静かに動くと、弱いまま本番へ出る**——**設定の誤りは入口で止める**
    expect(() =>
      readEncryptionKey({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(16, 7).toString("base64") }),
    ).toThrow("TOKEN_ENCRYPTION_KEY");
  });

  it("鍵が無ければ、使う前に落ちる", () => {
    expect(() => readEncryptionKey({})).toThrow("TOKEN_ENCRYPTION_KEY");
  });

  it("鍵が base64 でなければ、使う前に落ちる", () => {
    expect(() => readEncryptionKey({ TOKEN_ENCRYPTION_KEY: "!!!" })).toThrow(
      "TOKEN_ENCRYPTION_KEY",
    );
  });

  it("落ちるときに、鍵そのものを載せない", () => {
    // **例外の本文にも秘密を入れない**（§6）
    const secret = Buffer.alloc(16, 3).toString("base64");

    expect(() => readEncryptionKey({ TOKEN_ENCRYPTION_KEY: secret })).toThrow(
      new RegExp(`^(?!.*${secret.replaceAll("+", "\\+")}).*$`, "s"),
    );
  });
});
