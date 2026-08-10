import { describe, expect, it } from "vitest";
import { needsRefresh, tokenRequestError } from "./installation-token";

const now = new Date("2026-08-10T00:00:00Z");

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
