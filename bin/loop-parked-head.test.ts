import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-parked-head", import.meta.url));

/**
 * 保留にした時点の head を残す（#70）。
 *
 * **ループの外の著者は `parked` を外せない**（**fork から出す人に triage 権限は無い**）。
 * **master は外さない**と決めてあり、**ステップ 2 は `parked` を選ばない**ので、
 * **対応を push しても誰も見に来ない**——**理由は書いてあるので
 * `bin/loop-silent-park` にも出てこない**。
 *
 * **「戻すのは人である」とは衝突しない。** あの規定は**master の記憶に依存させるな**で、
 * **状態から機械的に決まるなら記憶ではない**（`bin/loop-claim audit` と同じ形）。
 * **保留にした head から動いていれば、外してよい。**
 */
describe("bin/loop-parked-head", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "parked-head-"));
    expect(spawnSync("git", ["init", "--quiet", repo]).status).toBe(0);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function run(args: string[]): { status: number; stdout: string; stderr: string } {
    const result = spawnSync(SCRIPT, args, { cwd: repo, encoding: "utf8" });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  const HEAD = "a".repeat(40);

  it("記録した head を、そのまま返す", () => {
    expect(run(["record", "12", HEAD]).status).toBe(0);

    const got = run(["get", "12"]);

    expect(got.status).toBe(0);
    expect(got.stdout.trim()).toBe(HEAD);
  });

  it("記録が無ければ、無いと言う", () => {
    // **人待ちの保留（先行 PR 待ちなど）には記録が無い。** そこを「動いた」と
    // 読むと、**master が外さないと決めた保留まで外れる**
    expect(run(["get", "12"]).status).toBe(1);
  });

  it("保留にし直したら、新しいほうを残す", () => {
    // **head が動いて外し、また保留になることがある。** 古い記録が残ると、
    // **次の周回で「動いた」と読まれ、対応していないのに外れる**
    run(["record", "12", HEAD]);
    run(["record", "12", "b".repeat(40)]);

    expect(run(["get", "12"]).stdout.trim()).toBe("b".repeat(40));
  });

  it("PR ごとに分かれている", () => {
    run(["record", "12", HEAD]);
    run(["record", "13", "b".repeat(40)]);

    expect(run(["get", "12"]).stdout.trim()).toBe(HEAD);
    expect(run(["get", "13"]).stdout.trim()).toBe("b".repeat(40));
  });

  it("消したら、記録は無くなる", () => {
    // **保留を外したら消す** (#176 のレビュー 2 周目)。**残すと、後日
    // 別の理由（レビュー上限など）で保留になったとき、古い head との差を
    // 「著者が対応した」と読んで即座に外す**——**人の判断待ちが消える**
    run(["record", "12", HEAD]);

    expect(run(["clear", "12"]).status).toBe(0);

    expect(run(["get", "12"]).status, "消えていない").toBe(1);
  });

  it("記録が無くても、消せたことにする", () => {
    // **消す側は何度呼ばれてもよい**（**外せたときだけ呼ぶ**が、
    // **前の周回で消えている**ことがある）
    expect(run(["clear", "12"]).status).toBe(0);
  });

  it("消しても、他の PR は残る", () => {
    run(["record", "12", HEAD]);
    run(["record", "13", "b".repeat(40)]);

    run(["clear", "12"]);

    expect(run(["get", "13"]).stdout.trim()).toBe("b".repeat(40));
  });

  it("head SHA として読めないものは記録しない", () => {
    // **ブランチ名や短すぎる値を入れると、前方一致が誤爆する**
    // （`bin/loop-review-head` と同じ判断）
    expect(run(["record", "12", "main"]).status).toBe(2);
    expect(run(["record", "12", "abc"]).status).toBe(2);
  });

  it("PR 番号は数字だけを受ける", () => {
    // **ファイル名になる**ので、パス操作を成立させない
    expect(run(["record", "../12", HEAD]).status).toBe(2);
    expect(run(["get", "12/../13"]).status).toBe(2);
  });

  it("使い方の誤りは 2", () => {
    expect(run([]).status).toBe(2);
    expect(run(["record", "12"]).status).toBe(2);
    expect(run(["unknown", "12"]).status).toBe(2);
  });
});
