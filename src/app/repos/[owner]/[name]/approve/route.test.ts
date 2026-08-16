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

import { describe, expect, it } from "vitest";
import { approveOutcomeParam, pullRequestNumberFrom } from "./route";

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
});

describe("結果を、押した人へ返す形にする", () => {
  it("押せた・押せなかったが、そのまま行き先に載る", () => {
    expect(approveOutcomeParam({ kind: "approved" })).toBe("approved");
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
