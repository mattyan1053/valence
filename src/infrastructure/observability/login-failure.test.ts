/**
 * **ログインが落ちた段だけを残す** (#248)。
 *
 * **出しているものより、出していないものを見る**（§5）。
 * **「調べにくいから」と本文を足した日に落ちる本が要る**——
 * **出す側だけを見る試験は、そのとき緑のまま通る。**
 */

import { describe, expect, it } from "vitest";
import { reportLoginFailure } from "./login-failure";

/** 書き出し先を受け取って、出た行を集める。**本物の標準エラーへ流さない。** */
function lines() {
  const written: string[] = [];
  return { written, write: (line: string) => written.push(line) };
}

/** **token を持った例外。** 実際に投げて、出力に現れないことを見る。 */
const LEAKY = new Error("PATCH /rest/v1 failed: bearer gho_secret-token (refresh ghr_secret)");

describe("落ちた段を残す", () => {
  it("段が分かる", () => {
    const { written, write } = lines();

    reportLoginFailure("save", LEAKY, write);

    expect(written.join("\n")).toContain("save");
  });

  it("例外の種類が分かる", () => {
    // **`z.ZodError` なのか通信の失敗なのかで、見るところが違う**
    const { written, write } = lines();

    reportLoginFailure("refresh", new TypeError("fetch failed"), write);

    expect(written.join("\n")).toContain("TypeError");
  });

  it("4 つの段を、そのまま名前で出す", () => {
    // **段が読めなければ、記録があっても人は動けない**
    for (const stage of ["exchange", "session", "refresh", "save"] as const) {
      const { written, write } = lines();

      reportLoginFailure(stage, LEAKY, write);

      expect(written.join("\n"), `${stage} が出ていない`).toContain(stage);
    }
  });

  it("例外の message を、そのまま出さない", () => {
    // **何が入るか保証できない**（§6）。**「出さないように書いた」では足りないので、
    // **実際に token を含む例外を投げて、出力に現れないことを見る**
    const { written, write } = lines();

    reportLoginFailure("save", LEAKY, write);

    const out = written.join("\n");
    expect(out, "token がそのまま出ている").not.toContain("gho_secret-token");
    expect(out, "refresh token がそのまま出ている").not.toContain("ghr_secret");
    expect(out, "message をそのまま載せている").not.toContain(LEAKY.message);
  });

  it("例外ではないものを投げられても、中身を出さない", () => {
    // **`throw "文字列"` も `throw {token}` も書ける。** **`Error` だけを想定すると、
    // そこだけ素通りになる**——**種類が分からないときこそ、中身を出さない**
    const { written, write } = lines();

    reportLoginFailure("exchange", { token: "gho_secret-token" }, write);

    expect(written.join("\n")).not.toContain("gho_secret-token");
  });

  it("入れ子の cause も出さない", () => {
    // **`cause` は既定の文字列化に現れうる。** **包んだ例外に token が入っていても同じ**
    const { written, write } = lines();

    reportLoginFailure("session", new Error("開けません", { cause: LEAKY }), write);

    expect(written.join("\n")).not.toContain("gho_secret-token");
  });

  it("1 行だけ書く", () => {
    // **成功した周回では 1 行も出ない**ことと合わせて、**毎回鳴る警告にしない**
    const { written, write } = lines();

    reportLoginFailure("save", LEAKY, write);

    expect(written).toHaveLength(1);
  });
});
