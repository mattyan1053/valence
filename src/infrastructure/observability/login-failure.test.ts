/**
 * **ログインが落ちた段だけを残す** (#248)。
 *
 * **出しているものより、出していないものを見る**（§5）。
 * **「調べにくいから」と本文を足した日に落ちる本が要る**——
 * **出す側だけを見る試験は、そのとき緑のまま通る。**
 */

import { describe, expect, it } from "vitest";
import { reportDroppedCallback, reportLoginFailure } from "./login-failure";

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

  it("5 つの段を、そのまま名前で出す", () => {
    // **段が読めなければ、記録があっても人は動けない**
    for (const stage of ["setup", "exchange", "session", "refresh", "save"] as const) {
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

describe("戻ってこなかったコールバックを残す", () => {
  it("どこへ来たのかが分かる", () => {
    // **`/auth/callback` が呼ばれない**ので、**落ちた段の記録**（#248）**は出ない**
    // ——**残るのは、この 1 行だけ**である
    const { written, write } = lines();

    reportDroppedCallback("/", write);

    expect(written.join("\n"), "どこへ来たのかが出ていない").toContain("/");
  });

  it("次に見る場所が分かる", () => {
    // **症状だけ残しても、人は動けない**——**2026-08-24 は、原因に辿り着くまでに
    // `curl` と `docker exec` が要った**
    const { written, write } = lines();

    reportDroppedCallback("/", write);

    expect(written.join("\n"), "許可一覧を指していない").toMatch(/許可/);
  });

  it("こちらが落としたとは言わない", () => {
    // **落としているのは GoTrue** で、**こちらから分かるのは「戻ってこなかった」まで**
    // である（`bin/doctor` の `[分かりません]` と同じ側）
    const { written, write } = lines();

    reportDroppedCallback("/", write);

    expect(written.join("\n"), "断定している").not.toMatch(/失敗しました|落としました/);
  });

  it("code を出さない", () => {
    // **`code` は交換できる値**である（§6）——**path しか渡さない**ことを、
    // **呼ぶ側ではなくこの口の形で担保する**
    const { written, write } = lines();

    reportDroppedCallback("/?code=7405c683-secret", write);

    expect(written.join("\n"), "code がそのまま出ている").not.toContain("7405c683-secret");
  });

  it("1 行だけ書く", () => {
    const { written, write } = lines();

    reportDroppedCallback("/", write);

    expect(written).toHaveLength(1);
    expect(written[0]).not.toContain("\n");
  });
});
