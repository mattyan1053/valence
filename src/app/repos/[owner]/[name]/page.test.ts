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
import { approveNoticeKind, dynamic, unreadableNote } from "./page";

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
  it("知っている結果だけを通す", () => {
    for (const kind of ["approved", "forbidden", "self-approval", "unavailable"] as const) {
      expect(approveNoticeKind(kind)).toBe(kind);
    }
  });

  it("知らない値は通さない", () => {
    // **通すと、こちらが言っていないことを画面に言わせられる**
    for (const value of ["", "ok", "承認しました", 1, null, undefined, ["approved"]]) {
      expect(approveNoticeKind(value), String(value)).toBeUndefined();
    }
  });
});
