/**
 * **マージを受け付ける口**（#331）。
 *
 * **判定はここに書き写さない**（`mergePullRequest` が持つ）。
 * **ここが見るのは、受け取った本文を内側の語彙へ直す部分と、戻し方**である。
 */

import { describe, expect, it } from "vitest";
import { boardRedirect } from "../board-redirect";
import { headShaFrom, mergeOutcomeParam, pullRequestNumberFrom } from "./route";

describe("送られてきた PR 番号を読む", () => {
  it("数として読めるものだけを通す", () => {
    expect(pullRequestNumberFrom("42")).toBe(42);
    expect(pullRequestNumberFrom(" 42 ")).toBe(42);
  });

  it("数でないもの・整数でないもの・負のものを通さない", () => {
    for (const value of ["", "abc", "4 2", "0", "-1", "1.5", "1e3", "0x2a", null, undefined]) {
      expect(pullRequestNumberFrom(value), String(value)).toBeUndefined();
    }
  });

  it("安全に扱えない大きさは通さない", () => {
    // **`Number` にすると丸まる**——**違う PR をマージすることになる**
    expect(pullRequestNumberFrom("9007199254740993")).toBeUndefined();
  });
});

describe("結果を、押した人へ返す形にする", () => {
  it("成功は、行き先に載せない", () => {
    // **`?merge=merged` を開くだけで「マージしました」と出てはならない**
    expect(mergeOutcomeParam({ kind: "merged" })).toBeUndefined();
  });

  it("押せなかった理由は、そのまま行き先に載る", () => {
    expect(mergeOutcomeParam({ kind: "forbidden" })).toBe("forbidden");
    expect(mergeOutcomeParam({ kind: "not-mergeable" })).toBe("not-mergeable");
  });

  it("見えないリポジトリを、押せなかった理由として区別しない", () => {
    // **§6。見えないリポジトリの存在を教えない**
    expect(mergeOutcomeParam({ kind: "not-found" })).toBe("unavailable");
    expect(mergeOutcomeParam({ kind: "signed-out" })).toBe("unavailable");
    expect(mergeOutcomeParam({ kind: "needs-login" })).toBe("unavailable");
  });
});

describe("押したあと、盤面へ戻す", () => {
  const request = new Request("http://localhost:3000/repos/acme/web/merge", { method: "POST" });

  it("303 で戻す（POST を持ち越さない）", () => {
    // **307 のままだと、盤面へメソッドごと再送されて 405 で終わる**
    // ——**マージは成功したのに、押した人はそれを知れない**
    expect(boardRedirect(request, { owner: "acme", name: "web" }, undefined).status).toBe(303);
  });

  it("押せなかった理由は、merge の名前で載せる", () => {
    // **`approve` と混ぜない**——**混ぜると、片方の理由がもう片方の画面に出る**
    const response = boardRedirect(
      request,
      { owner: "acme", name: "web" },
      {
        param: "merge",
        value: "not-mergeable",
      },
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/repos/acme/web?merge=not-mergeable",
    );
  });
});

describe("送られてきた head の commit を読む", () => {
  it("commit として有り得る形だけを通す", () => {
    expect(headShaFrom("5e2a91c4d7f60b83ae15cd429f70b6d8e3a142cb")).toBe(
      "5e2a91c4d7f60b83ae15cd429f70b6d8e3a142cb",
    );
  });

  it("形が違うものは通さない", () => {
    // **そのまま GitHub の要求へ載せる値**である
    for (const value of [
      "",
      "abc",
      "5E2A91C4D7F60B83AE15CD429F70B6D8E3A142CB",
      "5e2a91c4d7f60b83ae15cd429f70b6d8e3a142c",
      "5e2a91c4d7f60b83ae15cd429f70b6d8e3a142cbb",
      null,
      undefined,
    ]) {
      expect(headShaFrom(value), String(value)).toBeUndefined();
    }
  });
});
