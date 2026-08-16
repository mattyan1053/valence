/**
 * **1 つのリポジトリの盤面を出す画面**（#314）。
 *
 * **見られないリポジトリでは、存在も漏らさない**——**画面は `not-found` を
 * 404 へ倒す**ので、**「権限がありません」と「ありません」が区別できない。**
 * **判定そのものは `viewRepositoryBoard` が持っている**（ここに書き写さない）。
 *
 * **この画面も静的に焼けない。** **出すのは「いまログインしている人に何が見えるか」**
 * で、**焼き付けたら全テナントに同じものが出る**（`AGENTS.md` §1 の逆）。
 */

import { describe, expect, it } from "vitest";
import type { PullRequestApprovalListing } from "../../../../application/ports/pull-request-approvals";
import {
  approvalDisplay,
  approveNoticeKind,
  dynamic,
  mergeButtonBlock,
  mergeNoticeKind,
  unreadableNote,
} from "./page";

describe("リポジトリの盤面", () => {
  it("要求ごとに描く（静的に生成させない）", () => {
    // **次に誰かが「静的にすれば速い」と外したら、ここで赤くなる。**
    expect(dynamic).toBe("force-dynamic");
  });
});

describe("読めなかった PR を画面から消さない", () => {
  // **port が `invalid` を残しているのは、この最後の 1 歩のため**である
  // ——**捨てると「読めなかった」が「依存が無かった」に化ける。**
  it("読めなかったものがあれば、件数が出る", () => {
    expect(unreadableNote(2)).toContain("2");
  });

  it("無ければ、何も出さない", () => {
    expect(unreadableNote(0)).toBeUndefined();
  });

  it("理由は画面へ出さない", () => {
    // **Zod のメッセージには値が入りうる**（`app-credentials.ts` と同じ理由）
    expect(unreadableNote(1)).not.toMatch(/expected|received|invalid_type/i);
  });
});

describe("直前の承認の結果を出す", () => {
  // **`?approve=` は URL に載っている**ので、**誰でも好きな文字列を入れられる**
  // ——**並べたものだけを通す**（#330）
  it("知っている理由だけを通す", () => {
    for (const kind of ["forbidden", "self-approval", "unavailable"] as const) {
      expect(approveNoticeKind(kind)).toBe(kind);
    }
  });

  it("成功は、クエリ文字列から出さない", () => {
    // **`?approve=approved` を開くだけで「承認しました」と出てはならない**
    // （#342 のレビュー）——**利用者が任意に作れる値から、成功を断言しない。**
    expect(approveNoticeKind("approved")).toBeUndefined();
  });

  it("知らない値は通さない", () => {
    // **通すと、こちらが言っていないことを画面に言わせられる**
    for (const value of ["", "ok", "承認しました", 1, null, undefined, ["forbidden"]]) {
      expect(approveNoticeKind(value), String(value)).toBeUndefined();
    }
  });
});

describe("直前にマージできなかった理由を出す", () => {
  it("知っている理由だけを通す", () => {
    for (const kind of ["forbidden", "not-mergeable", "unavailable"] as const) {
      expect(mergeNoticeKind(kind)).toBe(kind);
    }
  });

  it("成功は、クエリ文字列から出さない", () => {
    // **`?merge=merged` を開くだけで「マージしました」と出てはならない**（#342 と同じ）
    expect(mergeNoticeKind("merged")).toBeUndefined();
  });

  it("依存の理由も通す", () => {
    for (const kind of ["dependency-pending", "not-orderable"] as const) {
      expect(mergeNoticeKind(kind)).toBe(kind);
    }
  });

  it("知らない値は通さない", () => {
    for (const value of ["", "ok", "マージしました", 1, null, undefined, ["forbidden"]]) {
      expect(mergeNoticeKind(value), String(value)).toBeUndefined();
    }
  });
});

<<<<<<< HEAD
/**
 * **承認済みかどうかを盤面に出す**（#343）。
 *
 * **押した結果は、盤面そのもので確かめる**——**成功はクエリ文字列に載らない**
 * （#342 のレビュー）。**この関数が読むのは、GitHub から引いた状態だけ**である
 * ——**引数に検索文字列が無いので、URL からは作れない。**
 */
describe("承認の状態を盤面へ出す", () => {
  const listing = (
    overrides: Partial<PullRequestApprovalListing> = {},
  ): PullRequestApprovalListing => ({
    approved: new Set(),
    unavailable: [],
    ...overrides,
  });

  it("承認済みの PR は、承認済みとして出す", () => {
    // **これが無いと、押した人は「何も起きなかった」と読んでもう一度押す**
    expect(approvalDisplay(7, listing({ approved: new Set([7]) }))).toBe("approved");
  });

  it("承認されていない PR は、承認済みに見せない", () => {
    // **全部を承認済みにする実装でも、上の 1 件だけなら緑になる**
    expect(approvalDisplay(8, listing({ approved: new Set([7]) }))).toBeUndefined();
  });

  it("読めなかった PR は、承認されていないと混ぜない", () => {
    // **同じ見た目にすると、押した人は「承認されていない」と読む**
    // ——**実際には、こちらが見ていないだけ**である
    expect(
      approvalDisplay(
        8,
        listing({ unavailable: [{ pullRequestNumber: 8, reason: "読めません" }] }),
      ),
    ).toBe("unknown");
  });

  it("読めなかった理由は、盤面へ出さない", () => {
    // **理由には値が入りうる**（`unreadableNote` と同じ理由）——**種別だけを返す**
    const display = approvalDisplay(
      8,
      listing({ unavailable: [{ pullRequestNumber: 8, reason: "secret-repository-name" }] }),
    );

    expect(String(display)).not.toContain("secret-repository-name");
  });
});

describe("依存の判定を、ボタンへ詰め替える", () => {
  // **判定そのものは domain が持つ**（#345）——**ここは詰め替えるだけ**
  it("土台が残っていれば、番号を渡す", () => {
    expect(mergeButtonBlock({ kind: "depends-on", numbers: [8] })).toEqual({ blockedBy: [8] });
  });

  it("順序が決められなければ、そう渡す", () => {
    expect(mergeButtonBlock({ kind: "not-orderable" })).toEqual({ notOrderable: true });
  });

  it("依存が無ければ、何も渡さない", () => {
    // **渡すと、押せる PR まで閉じる**
    expect(mergeButtonBlock({ kind: "ready" })).toEqual({});
  });
});
