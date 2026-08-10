import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 受け渡しの手順書。**両方に同じ担保が要る**ので、片方だけ直っても通らないようにする。 */
const PROCEDURES = [".claude/commands/loop-master.md", ".claude/commands/loop-worker.md"];

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

describe("受け渡しの通知", () => {
  it.each([...PROCEDURES, "loop/README.md"])("%s に、場面別の表を戻さない", (path) => {
    // **送るのは出口の 1 回だけ**（`bin/loop-handoff`）。場面別の表を併存させると、
    // **通常経路で 2 通飛ぶ**うえ、**列挙の漏れはそのまま残る**——
    // 出口へ一本化した意味が消える
    // **「消した側」だけでなく「指している側」も見る。** README から入った者が
    // **存在しない節を探す**うえ、新しい手順と食い違う（実際に残っていた）
    expect(read(path)).not.toContain("通知を送る場面");
  });

  it.each(PROCEDURES)("%s に、受け取ったらその場で 1 周回すことが書いてある", (path) => {
    // **送る側だけ書いても待ちは 1 分も減らない。** 受け取った側が動いて初めて縮む
    expect(read(path)).toContain("### 通知を受け取ったら");
  });

  it.each(PROCEDURES)("%s で、周回を保険と位置づけている", (path) => {
    // **通知が主、周回は保険。** 相手が居ない・送信に失敗した場合でも、
    // 次の周回で同じ結論に至れることが前提である
    expect(read(path)).toMatch(/保険/);
  });

  it.each([...PROCEDURES, "loop/README.md"])("%s に周回の間隔を書かない", (path) => {
    // **間隔を変えられるのはループを起動している人だけ**で、手順書からは変えられない。
    // 数字を書くと、実際の設定と食い違ったまま基準として読まれる
    expect(read(path)).not.toMatch(/[0-9]+\s*分/);
  });
});
