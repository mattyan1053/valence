/**
 * **承認を受け付ける口**（#330）。
 *
 * **判定はここに書き写さない**（`approvePullRequest` が持つ）。
 * **ここが見るのは、受け取った本文を内側の語彙へ直す部分**である
 * ——**フォームから来る値は文字列**なので、**数でないものを黙って通すと、
 * どの PR とも違う相手へ要求が出る。**
 *
 * **結果は行き先に載せて戻す**（`?approve=<kind>`）——**押した人へ理由が伝わること**が
 * この Issue の完了条件である。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boardRedirect } from "../board-redirect";
import {
  approveOutcomeParam,
  approveUnavailableReason,
  pullRequestNumberFrom,
  respondToApprove,
} from "./route";

/**
 * **戻り先は、開いたオリジンから組む** (#506)——**`Host` が許可一覧に載っている
 * ことが要る。** **この試験の中で渡す**（**`supabase/config.toml` に寄りかからない**
 * ——**あちらが変わると、関係のない理由でここが赤くなる**）。
 */
const SUPPLIED = "AUTH_ALLOWED_ORIGINS";
const suppliedBefore = process.env[SUPPLIED];

beforeAll(() => {
  process.env[SUPPLIED] = "http://localhost:3000,http://127.0.0.1:3000";
});

afterAll(() => {
  if (suppliedBefore === undefined) {
    delete process.env[SUPPLIED];
  } else {
    process.env[SUPPLIED] = suppliedBefore;
  }
});

describe("送られてきた PR 番号を読む", () => {
  it("数として読めるものだけを通す", () => {
    expect(pullRequestNumberFrom("42")).toBe(42);
  });

  it("数でないものは通さない", () => {
    // **黙って `NaN` を渡さない**——**どの PR とも違う相手へ要求が出る**
    for (const value of ["", "abc", "4 2", null, undefined]) {
      expect(pullRequestNumberFrom(value), String(value)).toBeUndefined();
    }
  });

  it("整数でないもの・負のものを通さない", () => {
    // **PR 番号は 1 以上の整数である**
    for (const value of ["0", "-1", "1.5", "1e3"]) {
      expect(pullRequestNumberFrom(value), value).toBeUndefined();
    }
  });

  it("前後に空白があっても、番号として読む", () => {
    expect(pullRequestNumberFrom(" 42 ")).toBe(42);
  });

  it("安全に扱えない大きさは通さない", () => {
    // **`Number` にすると丸まる大きさ**——**別の PR 番号に化ける**
    expect(pullRequestNumberFrom("9007199254740993")).toBeUndefined();
  });
});

describe("結果を、押した人へ返す形にする", () => {
  it("成功は、行き先に載せない", () => {
    // **`?approve=` は利用者が任意に作れる**（#342 のレビュー）——**載せると、
    // 承認していない人が URL を開くだけで「承認しました」と出る。**
    // **`approved` は取り消せない事実の主張**で、**見た人は次の行動へ移る。**
    expect(approveOutcomeParam({ kind: "approved" })).toBeUndefined();
  });

  it("押せなかった理由は、そのまま行き先に載る", () => {
    // **偽装されても、断言している内容は「起きなかった」**である
    expect(approveOutcomeParam({ kind: "forbidden" })).toBe("forbidden");
    expect(approveOutcomeParam({ kind: "self-approval" })).toBe("self-approval");
  });

  it("ログインの状態は、画面が扱う形へ寄せる", () => {
    // **盤面と同じ語彙にする**——**画面が 2 通りの言葉を覚えなくてよい**
    expect(approveOutcomeParam({ kind: "signed-out" })).toBe("unavailable");
    expect(approveOutcomeParam({ kind: "needs-login" })).toBe("unavailable");
  });

  it("見えないリポジトリを、押せなかった理由として区別しない", () => {
    // **§6。**「権限がありません」と「ありません」を区別できる応答にしない**
    // ——**ここで `not-found` を返すと、見えないリポジトリの存在を教える**
    expect(approveOutcomeParam({ kind: "not-found" })).toBe("unavailable");
  });
});

describe("押せなかった理由を、サーバ側へ残す（#506 の 2）", () => {
  // **画面には出せない**——**4 つを 1 語（`unavailable`）にまとめてある**（§6）。
  // **どこにも残らないと、利用者が「押せない」と言っても、どれか分からない。**

  it("まとめられた 4 つを、そのまま区別できる形で残す", () => {
    for (const kind of ["signed-out", "needs-login", "not-found", "unavailable"] as const) {
      expect(approveUnavailableReason({ kind }), kind).toBe(kind);
    }
  });

  it("押した人へ理由が届いているものは、残さない", () => {
    // **`forbidden` / `self-approval` は画面に出る**——**記録する必要が無い。**
    expect(approveUnavailableReason({ kind: "forbidden" })).toBeUndefined();
    expect(approveUnavailableReason({ kind: "self-approval" })).toBeUndefined();
  });

  it("押せたときは、残さない", () => {
    // **毎回鳴る記録は、そのうち読まれなくなる**（#248）
    expect(approveUnavailableReason({ kind: "approved" })).toBeUndefined();
  });
});

describe("押した要求そのものが、記録の口を呼ぶ（#510 のレビュー）", () => {
  // **書いてあることと、呼ばれることは別**である——**呼び出しを消しても、
  // 部品だけを見る試験は緑のまま**だった。**要求の経路を通す。**
  //
  // **モックは使わない**（`AGENTS.md` §4）——**受け口をインメモリの実装で渡す。**

  function pressed(body: Record<string, string>): Request {
    const form = new FormData();
    for (const [key, value] of Object.entries(body)) {
      form.set(key, value);
    }
    return new Request("http://localhost:3000/repos/acme/web/approve", {
      method: "POST",
      headers: { host: "localhost:3000" },
      body: form,
    });
  }

  function recorder() {
    const recorded: string[] = [];
    return {
      recorded,
      report: (action: string, kind: string) => recorded.push(`${action}=${kind}`),
    };
  }

  it("読めない要求は、GitHub を叩かずに残す", async () => {
    const { recorded, report } = recorder();
    let asked = 0;

    await respondToApprove(
      pressed({ number: "abc" }),
      { owner: "acme", name: "web" },
      {
        approve: async () => {
          asked += 1;
          return { kind: "approved" };
        },
        report,
      },
    );

    expect(asked, "読めない要求で GitHub を叩いている").toBe(0);
    expect(recorded).toEqual(["approve=unreadable-request"]);
  });

  it("まとめられた理由は、まとめる前の形で残る", async () => {
    const { recorded, report } = recorder();

    const response = await respondToApprove(
      pressed({ number: "42" }),
      { owner: "acme", name: "web" },
      { approve: async () => ({ kind: "needs-login" }), report },
    );

    expect(recorded).toEqual(["approve=needs-login"]);
    // **画面には、まとめた語しか出さない**（§6）
    expect(response.headers.get("location")).toContain("approve=unavailable");
  });

  it("握り潰した例外の落ちどころも、記録に出る", async () => {
    // **#506 の 2-b**——**`kind=unavailable` だけでは「なぜ」が出ない**（**例外を
    // 握り潰している側**）。**種類だけを添える**（中身は出さない。§6）。
    const { recorded, report } = recorder();

    await respondToApprove(
      pressed({ number: "42" }),
      { owner: "acme", name: "web" },
      { approve: async () => ({ kind: "unavailable", reason: "approve/TypeError" }), report },
    );

    expect(recorded).toEqual(["approve=unavailable/approve/TypeError"]);
  });

  it("押せたときは、何も残さない", async () => {
    const { recorded, report } = recorder();

    const response = await respondToApprove(
      pressed({ number: "42" }),
      { owner: "acme", name: "web" },
      { approve: async () => ({ kind: "approved" }), report },
    );

    expect(recorded).toEqual([]);
    expect(response.headers.get("location")).toBe("http://localhost:3000/repos/acme/web");
  });
});

describe("押したあと、盤面へ戻す", () => {
  const request = new Request("http://localhost:3000/repos/acme/web/approve", {
    method: "POST",
    headers: { host: "localhost:3000" },
  });

  it("303 で戻す（POST を持ち越さない）", () => {
    // **`redirect()` は Route Handler では 307**（#342 のレビュー）——
    // **ブラウザはメソッドと本文を保持したまま盤面 URL へ再送する**ので、
    // **盤面に POST handler が無い以上 405 になる。**
    // **承認が成功しても、盤面にも失敗の理由にも到達できない。**
    const response = boardRedirect(request, { owner: "acme", name: "web" }, undefined);

    expect(response.status).toBe(303);
  });

  it("成功のときは、理由を付けずに盤面へ戻す", () => {
    const response = boardRedirect(request, { owner: "acme", name: "web" }, undefined);

    expect(response.headers.get("location")).toBe("http://localhost:3000/repos/acme/web");
  });

  it("押せなかった理由は、盤面の URL に載せて戻す", () => {
    const response = boardRedirect(
      request,
      { owner: "acme", name: "web" },
      { param: "approve", value: "self-approval" },
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/repos/acme/web?approve=self-approval",
    );
  });

  it("開いたオリジンの上に組み立てる", () => {
    // **設定へ書き固めない**（`src/app/auth/urls.ts` と同じ理由）。
    // **待ち受けアドレスと違うときに何が起きるかは `../board-redirect.test.ts`**（#506）
    const other = new Request("http://127.0.0.1:3000/repos/acme/web/approve", {
      method: "POST",
      headers: { host: "127.0.0.1:3000" },
    });

    expect(
      boardRedirect(other, { owner: "acme", name: "web" }, undefined).headers.get("location"),
    ).toBe("http://127.0.0.1:3000/repos/acme/web");
  });

  it("owner / name に記号が入っても、経路として組み立てる", () => {
    // **そのまま繋ぐと、`..` や `?` で別の場所へ戻せる**
    const response = boardRedirect(request, { owner: "a/../b", name: "c?d" }, undefined);

    expect(response.headers.get("location")).toBe("http://localhost:3000/repos/a%2F..%2Fb/c%3Fd");
  });
});
