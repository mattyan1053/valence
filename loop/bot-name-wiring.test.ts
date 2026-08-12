import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 出所。**ここでも書き写さない**——`bin/loop-review-commits` が正である。 */
const BOT = execFileSync(join(REPO_ROOT, "bin/loop-review-commits"), ["--bot"]).toString().trim();

/** 走らせるものと、その試験。 */
function filesUnder(dir: string): string[] {
  return readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(dir, entry.name));
}

/** その名前が literal で書いてあるファイル。 */
function filesWithLiteral(paths: string[]): string[] {
  return paths.filter((path) => readFileSync(join(REPO_ROOT, path), "utf8").includes(BOT));
}

/**
 * レビュー用 bot の名前を、1 箇所だけに置く（#135）。
 *
 * **4 箇所に写っていた。** しかも **`bin/loop-handoff` だけ `[bot]` 無し**で、
 * **偶然ではない**——**GraphQL の `author.login` は付けず、REST は付ける**。
 * **同じ相手を、API ごとに別の文字列で持っていた**。
 *
 * **壊れ方がいちばん静かである。** 名前が合わないと**そのレビューを数えない**ので、
 * 症状は「**正しい PR がまた止まる**」だけ——**ゲートの出力を読む master には、
 * 「Codex が返していない」（#159 で 2 時間止まった形）と区別が付かない**。
 *
 * **「呼んでいる」だけを見ない。** **`--bot` を呼びながら、返ってきた値を使わずに
 * `[bot]` を足し直していたら、寄せた意味が消える**——**#169 で踏んだ
 * 「入れたが、誰も見ていない」と同じ形**である。**使う側の試験も `--bot` から取る**ので、
 * **出所を変えれば、写しを持っているものだけが落ちる**。
 */
describe("レビュー用 bot の名前", () => {
  it("走るものの中では、1 箇所にしかない", () => {
    // **`bin/` と `task` と手順書**を見る。**試験は別に見る**（下）
    const running = [
      ...filesUnder("bin").filter((path) => !path.endsWith(".test.ts")),
      "task",
      ...filesUnder(".claude/commands"),
    ];

    expect(filesWithLiteral(running)).toEqual(["bin/loop-review-commits"]);
  });

  it("試験の中でも、1 箇所にしかない", () => {
    // **出所の試験だけが値を留める。** そこが**変えるときに必ず通る場所**である——
    // **他の試験が写しを持つと、出所を変えても緑のまま**になり、
    // **「追随している」ことを確かめられない**
    const tests = [...filesUnder("bin"), ...filesUnder("loop")].filter((path) =>
      path.endsWith(".test.ts"),
    );

    expect(filesWithLiteral(tests)).toEqual(["bin/loop-review-commits.test.ts"]);
  });

  it("`[bot]` の有無を、呼ぶ側で足し直さない", () => {
    // **GraphQL 用は「取り除く」で作る**（`${REVIEW_BOT%\[bot\]}`）。
    // **足す側で書くと、出所が `[bot]` 無しに変わったときに二重に付く**——
    // **寄せた先が両方の形を出せる**ことが要る
    for (const path of filesUnder("bin").filter((p) => !p.endsWith(".test.ts"))) {
      const body = readFileSync(join(REPO_ROOT, path), "utf8");
      expect(body, `${path} が [bot] を足している`).not.toMatch(/\$\{?REVIEW_BOT\}?\[bot\]/);
    }
  });
});
