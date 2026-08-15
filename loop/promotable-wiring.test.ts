import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const PROCEDURE = ".claude/commands/loop-master.md";

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/** 見出しで区切った 1 節（**節の外の散文で条件が満たされない**ようにする）。 */
function section(heading: string): string {
  const after = read(PROCEDURE).split(heading)[1] ?? "";
  return after.split(/\n#{2,4} /)[0] ?? "";
}

/**
 * 「いま渡せないもの」を、状態として残すこと（#312）。
 *
 * **`backlog` に「いま渡せないもの」しか残っていない周回**は、**ループが正常に動いた
 * まま、空転を 1 度も記録せずに止まる**——**`no-work` は `backlog` が 0 件のときだけ**
 * 積まれ、**出口は「昇格の番」と言い続ける**。**3 周で人を呼ぶ仕掛けが、
 * 呼ぶべき場面で働かない**（#47 で塞いだ形が、別の場所に開いていた）。
 *
 * **判定はスクリプトが持つ**（`bin/loop-handoff`）。**ここで見るのは、その判定が
 * 読む印を、master が実際に付けるか**である——**置く側と読む側は 1 組**で、
 * **付ける側が無ければ、判定は永久に「全部渡せる」と答える。**
 */
describe("いま昇格できない backlog", () => {
  it("判定に使う印を、master が付ける", () => {
    // **master の記憶に置かない。** **セッションが落ちれば消える**ので、
    // **次の周回は同じ判断をやり直すだけ**になり、どこにも出てこない
    const doc = read(PROCEDURE);

    expect(doc, "条件待ちの印を付ける手が無い").toMatch(/--add-label waiting-condition/);
    expect(doc, "条件が来たときに外す手が無い").toMatch(/--remove-label waiting-condition/);
  });

  it("印を付けたら、理由も残す", () => {
    // **label だけでは「何を待っているか」が分からない**——**次に見る人（人間を含む）は、
    // 条件が来たかどうかを判断できない**
    expect(section("### 昇格できないものを、待たせておく"), "理由を残すと書いていない").toMatch(
      /gh issue comment/,
    );
  });

  it("その印を、出口の判定が読んでいる", () => {
    // **付ける側と読む側は 1 組である。** **読まないなら、付けていないのと同じ**
    const handoff = read("bin/loop-handoff");

    expect(handoff, "出口が印を読んでいない").toContain('labels:["backlog","waiting-condition"]');
    expect(handoff, "件数だけで昇格の番を決めている").toMatch(/promotable > 0 && ready == 0/);
  });

  it("印は `./task loop:setup` が用意する", () => {
    // **存在しない label を書いても GitHub は黙って落とす**——
    // **付けたつもりのまま、どの一覧にも現れない**（`loop/labels.test.ts` と同じ理由）
    const match = read("task").match(/for label in ([^;]+); do/);

    expect(match?.[1]?.split(/\s+/), "label が用意されていない").toContain("waiting-condition");
  });

  it("`blocked` の意味を広げていない", () => {
    // **`blocked` は「人の判断待ち」**（`loop/README.md`）で、
    // **「条件がまだ来ていない」は人と関係ない**——**名前が測っているものとずれる**のが、
    // このループで何度も直している形である
    const readme = read("loop/README.md");
    const blocked = readme.split("\n").filter((line) => /^\|\s*`blocked`/.test(line))[0] ?? "";

    expect(blocked, "blocked の説明が条件待ちへ広がっている").not.toMatch(/条件/);
  });

  it("作業が尽きた判定が、昇格できるかで決まっている", () => {
    // **`backlog` が 0 件かどうかでは決まらない** (#312)。**渡せるものが無い周回は、
    // `backlog` に何件残っていても `no-work` である**
    const ended = section("### 作業が尽きたとき");

    expect(ended, "尽きた条件が backlog の件数のままである").toMatch(/waiting-condition/);
  });

  it("その識別子が、一覧にある", () => {
    // **一覧に無い識別子は弾かれる**（`bin/loop-stall` は書式まで見る）
    const listed = execFileSync(join(REPO_ROOT, "bin/loop-stall"), ["--list"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    expect(listed).toContain("no-work");
  });
});
