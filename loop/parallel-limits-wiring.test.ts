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
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { procedureText } from "./procedure-doc";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/**
 * 上限を語りうる文書を、**並べずに集める** (#238 のレビュー)。
 *
 * **3 回続けて抜けたのは、並べ方ではなく「どれを見るか」だった**——
 * **`loop/README.md` を 1 つずつ別の本で見ていたので、足した検査が届かなかった。**
 * **増えた文書が自動で入る**ようにする。
 */
function docs(): string[] {
  // **下の階層まで見る** (#319)。**手順書の本体を `loop/procedure/` へ移した**ので、
  // **1 階層だけ読むと、いちばん長い文書が走査から外れる**——
  // **この関数が塞ごうとした「足した検査が届かない」が、そのまま戻る。**
  const dirs = [".claude/commands", "loop", "loop/procedure"];
  return dirs.flatMap((dir) =>
    readdirSync(join(REPO_ROOT, dir))
      .filter((name) => name.endsWith(".md"))
      .map((name) => `${dir}/${name}`),
  );
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

  for (const role of ["master", "worker"] as const) {
    it(`${role} は、3 件以上で止めると書いている`, () => {
      // **上限そのものは、役ごとに 1 回書いてあればよい** (#319)。
      // **入口と本体に分かれた**ので、**ファイルごとに求めると入口が必ず落ちる**——
      // **見るのは「その役が 1 周で読むもの」**である
      expect(procedureText(role), "3 件以上で止めると書いていない").toMatch(/3 件以上/);
    });
  }

  for (const doc of docs()) {
    it(`${doc} が、2 件を正常として扱っている`, () => {
      const body = read(doc);

      // **古い規則が残っていないこと。** **1 つ残っていれば、そこで止まる**
      expect(body, "2 件で止める規則が残っている").not.toMatch(/`ready` が 2 件以上/);
      // **分岐だけ直しても、語り口が残る** (#85 の周回で実際に残した)——
      // **見出しと導入は、分岐より先に読まれる**
      expect(body, "「1 件だけ」と語っているところが残っている").not.toMatch(
        /`ready` の 1 件|同時に 1 件だけ|1 件に保/,
      );
    });
  }

  for (const doc of docs()) {
    it(`${doc} が、worker を 1 人だと言っていない`, () => {
      // **「1 人が同時に持つ PR は 1 本」は、いまも正しい**（変わったのは全体の本数）——
      // **嘘になったのは「全体で 1 本」と「worker は 1 人」のほう**である。
      // **規則の名前として引用しているところ**（「同時に持つ PR は 1 本」）**は残してよい。**
      const body = read(doc);

      expect(body, "worker が 1 人だと書いてある").not.toMatch(/worker [はも] 1 人/);
      expect(body, "全体で 1 本だと書いてある").not.toMatch(
        /同時に open (な|にしてよい) PR は 1 本/,
      );
    });
  }
});

describe("worker の PR は、作業場ごとに数える", () => {
  it("手順書が、自分の作業場のものだけを数えている", () => {
    // **`--author @me` は 2 人分を返す**ので、**そのまま数えると
    // 2 人目が動いているだけで 1 人目が止まる**
    const body = procedureText("worker");

    expect(body, "数えるところで持ち主を確かめていない").toContain("bin/loop-claim mine");
  });

  it("自分のものでない PR を、置き去りにしない", () => {
    // **持ち主が二度と戻らなくても `mine` は exit 1 のまま**（#238 のレビュー）——
    // **引き継ぐ経路は `bin/loop-claim pr` の中にあるのに、手前で落とすと辿り着けない。**
    // **見分けるのはやめて、経路を通す**——**worker は周回の間 lease を持たない**ので、
    // **寝ているのと死んだのは区別が付かない。**
    // **数えている節の中を見る。** **別の節（ステップ 3）に `bin/loop-claim pr` が
    // あるのは当たり前**なので、そこまで含めると、**何も書かなくても緑になる**
    const body = procedureText("worker");
    const section = body.slice(
      body.indexOf("### 2.1 master へ知らせる"),
      body.indexOf("### 2.2 公開に失敗した周回を再開する"),
    );

    expect(section, "数えるところが見当たらない").toContain("bin/loop-claim mine");
    expect(section, "自分のものでない PR を試す経路が無い").toContain("bin/loop-claim pr");
    expect(section, "引き継げることが書いていない").toMatch(/引き継/);
    // **空き枠のぶんだけ取る** (#238 のレビュー 2 周目)。**まとめて取ると、
    // 「1 人が両方持って止まる」に置き換わるだけ**である
    expect(section, "何本まで取るのかが書いていない").toMatch(/1 本だけ|空き枠/);
  });

  it("作った PR を、その場で自分のものにしている", () => {
    // **記録が無いと「誰の持ち物か」を後から決められない。**
    // **作った直後が、いちばん確かな場所**である
    const body = procedureText("worker");
    const created = body.indexOf("gh pr create");
    const claimed = body.indexOf("bin/loop-claim pr <PR番号>", created);

    expect(created, "PR を作るところが見当たらない").toBeGreaterThanOrEqual(0);
    expect(claimed, "作った PR を自分のものにしていない").toBeGreaterThan(created);
  });
});
