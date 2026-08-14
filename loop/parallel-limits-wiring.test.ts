/**
 * **上限を変えたら、その数を語っている側を数える**（`AGENTS.md` §5。#85）。
 *
 * **`ready` は 2 件まで、worker の PR は 1 人 1 本（全体で 2 本）**になった。
 * **変えた側の diff には、語っている側は出てこない**——**停止の識別子の説明、
 * 両方の手順書、`loop/README.md` が、それぞれ別の場所で同じ上限を語っている。**
 *
 * **「書いてあること」ではなく「残っていないこと」も見る**（#226 のレビュー）。
 * **古い上限（`ready` が 2 件で止める）が 1 つでも残っていると、
 * 2 人目が動いた瞬間に、動いている側が止まる。**
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/** `bin/loop-stall --list` の説明。**上限の正はここではないが、嘘であってはいけない。** */
function stallList(): string {
  const listed = spawnSync(join(REPO_ROOT, "bin/loop-stall"), ["--list"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  expect(listed.status, listed.stderr).toBe(0);
  return listed.stdout;
}

describe("`ready` の上限は 2 件", () => {
  it("停止の識別子の説明が、上限と噛み合っている", () => {
    // **説明が嘘になると、次に読む人は「2 件で止まる」と思って手順書を直す**
    const line = stallList()
      .split("\n")
      .find((candidate) => candidate.includes("too-many-ready"));

    expect(line, "too-many-ready が一覧に無い").toBeDefined();
    expect(line, "止める件数が上限と噛み合っていない").toContain("3 件以上");
  });

  for (const doc of [".claude/commands/loop-master.md", ".claude/commands/loop-worker.md"]) {
    it(`${doc} が、2 件を正常として扱っている`, () => {
      const body = read(doc);

      // **古い規則が残っていないこと。** **1 つ残っていれば、そこで止まる**
      expect(body, "2 件で止める規則が残っている").not.toMatch(/`ready` が 2 件以上/);
      expect(body, "3 件以上で止めると書いていない").toMatch(/3 件以上/);
    });
  }

  it("loop/README.md も、2 件を正常として扱っている", () => {
    expect(read("loop/README.md"), "2 件で止める説明が残っている").not.toMatch(
      /`ready` が 2 件以上あると/,
    );
  });
});

describe("worker の PR は、作業場ごとに数える", () => {
  it("手順書が、自分の作業場のものだけを数えている", () => {
    // **`--author @me` は 2 人分を返す**ので、**そのまま数えると
    // 2 人目が動いているだけで 1 人目が止まる**
    const body = read(".claude/commands/loop-worker.md");

    expect(body, "数えるところで持ち主を確かめていない").toContain("bin/loop-claim mine");
  });

  it("作った PR を、その場で自分のものにしている", () => {
    // **記録が無いと「誰の持ち物か」を後から決められない。**
    // **作った直後が、いちばん確かな場所**である
    const body = read(".claude/commands/loop-worker.md");
    const created = body.indexOf("gh pr create");
    const claimed = body.indexOf("bin/loop-claim pr <PR番号>", created);

    expect(created, "PR を作るところが見当たらない").toBeGreaterThanOrEqual(0);
    expect(claimed, "作った PR を自分のものにしていない").toBeGreaterThan(created);
  });
});
