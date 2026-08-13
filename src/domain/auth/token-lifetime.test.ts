import { describe, expect, it } from "vitest";
import { isUsable, REFRESH_MARGIN_SECONDS } from "./token-lifetime";

/**
 * **ユーザートークンは 8 時間で失効する**（この App は
 * "User-to-server token expiration" にオプトイン済み）。
 *
 * **倒す先は 2 つある。** **切れたものを使う**と「ログインしているのに 401」になり、
 * **使えるものを切れたと読む**と、**毎回ログインをやり直させる**——
 * **どちらか片方だけを見ると、もう片方の向きで緑になる。**
 */
describe("ユーザートークンが使えるか", () => {
  const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));

  it("期限まで間があれば、使える", () => {
    expect(isUsable({ expiresAt: at(3600) }, at(0))).toBe(true);
  });

  it("期限を過ぎていれば、使えない", () => {
    expect(isUsable({ expiresAt: at(0) }, at(1))).toBe(false);
  });

  it("期限の直前は、使えないほうへ倒す", () => {
    // **期限ちょうどまで使うと、要求を送っている途中で切れうる**——
    // **切れた token は 401 を返す**ので、**症状が「権限が無い」と見分けられなくなる**
    //（`installation-token` が同じ理由で余裕を取っている）
    expect(isUsable({ expiresAt: at(REFRESH_MARGIN_SECONDS) }, at(0))).toBe(false);
    expect(isUsable({ expiresAt: at(REFRESH_MARGIN_SECONDS + 1) }, at(0))).toBe(true);
  });

  it("持っていなければ、使えない", () => {
    // **無いことを「まだ切れていない」と読まない**
    expect(isUsable(undefined, at(0))).toBe(false);
  });
});
