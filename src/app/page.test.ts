/**
 * **この画面は静的に焼けない**（#213 のレビュー）。
 *
 * **「いまログインしている人に何が見えるか」**を出すので、**ビルドした瞬間の状態を
 * 焼き付けたら、全テナントに同じものが出る**——**`AGENTS.md` §1 の
 * 「実行時に解決する。設定に固定しない」の逆**である。
 *
 * **落ちているのは env の不足ではない。** **環境変数をビルドへ渡すと通るが、
 * 直っていない**——**直すべきは「このページが静的でよい」という前提**のほうである。
 *
 * **`next build` は `./task check` に入っていない**ので、**手元で緑でも
 * ここは見ていない**——**印を外したら赤になる本を、こちらに置く。**
 */

import { describe, expect, it } from "vitest";
import { boardPath, dynamic, invalidNote } from "./page";

describe("読めなかったものを画面から消さない", () => {
  // **port が `invalid` を残しているのは、この最後の 1 歩のため**である
  // （**捨てると「読めなかった」が「見えなかった」に化ける**）——
  // **画面が `repositories` だけを描くと、そこで化ける**（#213 のレビュー）。
  it("読めなかったものがあれば、件数が出る", () => {
    expect(invalidNote(2)).toContain("2");
  });

  it("無ければ、何も出さない", () => {
    expect(invalidNote(0)).toBeUndefined();
  });

  it("理由は画面へ出さない", () => {
    // **Zod のメッセージには値が入りうる**（`app-credentials.ts` と同じ理由）
    expect(invalidNote(1)).not.toMatch(/expected|received|invalid_type/i);
  });
});

describe("盤面への行き先", () => {
  // **並べるだけでは、依存グラフもリスク Tier も見られない** (#314)
  it("リポジトリごとの画面を指す", () => {
    expect(boardPath({ owner: "acme", name: "web" })).toBe("/repos/acme/web");
  });

  it("名前をそのまま繋がない", () => {
    // **`/` や `..` の入った値で、別の経路を指させない**
    expect(boardPath({ owner: "acme", name: "../../auth/logout" })).toBe(
      "/repos/acme/..%2F..%2Fauth%2Flogout",
    );
  });
});

describe("入口の画面", () => {
  it("要求ごとに描く（静的に生成させない）", () => {
    // **次に誰かが「静的にすれば速い」と外したら、ここで赤くなる。**
    // **`next build` を呼ばずに済ませている**ぶん、**見ているのは印だけ**である
    // ——**印が効いていることは Next.js の側が持っている。**
    expect(dynamic).toBe("force-dynamic");
  });
});
