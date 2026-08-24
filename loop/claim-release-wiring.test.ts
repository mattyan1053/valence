/**
 * **返す口が、手順書から呼べること**（#460 のレビュー）。
 *
 * **口を足しただけでは、運用は変わらない。** **worker が実際に読むのは
 * `loop/procedure/worker.md`** で、**そこに書かれていない口は、誰も打たない**
 * ——**取り違えた claim が元の作業場に残る**という、**この Issue が消しに来た状態が
 * そのまま残る。**
 *
 * **同じ形を 2 度踏んでいる**——**#306 は PR について同じことを直し、手順書にも
 * 書いてある**（ステップ 3）。**Issue のほうだけが、書かれていなかった。**
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(REPO_ROOT, "bin/loop-claim");

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/** 手順書の 2.2（着手中の Issue を拾う経路）。**取り違えが起きるのはここ。** */
function resumeSection(): string {
  const body = read("loop/procedure/worker.md");
  const from = body.indexOf("### 2.2");
  expect(from, "手順書に 2.2 がありません").toBeGreaterThanOrEqual(0);
  const rest = body.slice(from);
  const to = rest.indexOf("\n## ");
  return to < 0 ? rest : rest.slice(0, to);
}

/** `bin/loop-claim` の使い方に並ぶ口。 */
function documentedActions(): string[] {
  const script = read("bin/loop-claim");
  const from = script.indexOf("usage() {");
  expect(from, "bin/loop-claim に usage がありません").toBeGreaterThanOrEqual(0);
  const usage = script.slice(from).split("\n}\n")[0] ?? "";
  return [...usage.matchAll(/bin\/loop-claim ([a-z-]+)/g)].map((found) => found[1] ?? "");
}

/** 2.2 の「別の作業場が PR を持っていた」分岐（`bin/loop-claim pr` の答えで分ける）。 */
function prOwnershipBranch(): string {
  const section = resumeSection();
  const from = section.indexOf("bin/loop-claim pr <PR番号>");
  expect(from, "2.2 に PR を取る経路がありません").toBeGreaterThanOrEqual(0);
  const rest = section.slice(from);
  const to = rest.indexOf("esac");
  expect(to, "分岐が閉じていません").toBeGreaterThanOrEqual(0);
  return rest.slice(0, to);
}

describe("取り違えた Issue を返す道", () => {
  it("手順書の 2.2 が、返す口を名指ししている", () => {
    // **引き継げる経路にだけ、取り違えが起きる**——**戻り道は、そこに書く**
    expect(resumeSection(), "取り違えたときの戻り道が、手順書に無い").toContain(
      "bin/loop-claim release-issue",
    );
  });

  it("取り違えが確定する分岐で、返してから終わる", () => {
    // **散文で名前を挙げるだけでは打たれない** (#460 のレビュー 2 周目)。
    // **`resume` が exit 0 を返した時点で、Issue の記録はこちらのもの**である
    // ——**そのうえで PR が「別の作業場のもの」だと分かる。** **そこで返さずに
    // 終わると、本来の持ち主は自分の Issue を取り返せない。**
    const branch = prOwnershipBranch();
    const other = branch.slice(branch.indexOf("\n      1)"));

    expect(other, "別の作業場のものと分かった分岐で、返していない").toContain(
      "bin/loop-claim release-issue",
    );
  });

  it("判定できない分岐では、返さない", () => {
    // **返してよいと分かるのは「別の作業場のもの」と言われたときだけ**である
    // ——**判定できないときに返すと、本当に自分の作業だった場合に手放す。**
    const branch = prOwnershipBranch();
    const unknown = branch.slice(branch.indexOf("\n      *)"));

    expect(unknown, "判定できないのに返している").not.toContain("release-issue");
  });

  it("スクリプトが、その口を受ける", () => {
    // **手順書に書いてあっても、スクリプトが知らなければ使い方の誤りで落ちる**
    // ——**名前を変えた日に、手順書だけが古くなる。**
    const dir = mkdtempSync(join(tmpdir(), "claim-release-"));
    sandboxes.push(dir);
    expect(spawnSync("git", ["init", "--quiet", "-b", "main", dir]).status).toBe(0);

    const done = spawnSync(SCRIPT, ["release-issue", "42"], { cwd: dir, encoding: "utf8" });

    // **記録が無いので 0**（**返す先が無いのは失敗ではない**）。**2 は使い方の誤り**である
    expect(done.status, `使い方の誤りで落ちている: ${done.stderr}`).toBe(0);
  });

  it("手順書が名指しする口は、すべて使い方に載っている", () => {
    // **書いてある口と、在る口を突き合わせる**（`loop/labels.test.ts` と同じ形）
    const named = new Set(
      [...read("loop/procedure/worker.md").matchAll(/bin\/loop-claim ([a-z-]+)/g)].map(
        (found) => found[1] ?? "",
      ),
    );
    const documented = documentedActions();

    expect(
      [...named].filter((action) => !documented.includes(action)),
      "在らない口を書いている",
    ).toEqual([]);
  });
});
