import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-outside-author", import.meta.url));

/**
 * その PR の著者が、ループの外にいるか（#70）。
 *
 * **ループの外にいる著者は、次に呼ばれるまで動かない。** master は対応待ちの停止を
 * 積むが、**SHA が変わらないので識別子も変わらず、3 周で `loop/STOP`** に達する——
 * **一人の不在が全体停止になる**。**常駐している側の手が、常駐していない人を待って
 * 止まる**のはおかしい。
 *
 * **役ではなくアカウントで見る。** **#174（同じアカウントなので master と worker を
 * 見分けられない）とは別の問い**である——ここで要るのは**「ループの中か外か」**だけで、
 * **master も worker もループの中**だから、**役を見分ける必要が無い**。
 */
describe("bin/loop-outside-author", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "outside-author-"));
    mkdirSync(join(sandbox, "path"), { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  /** 偽の `gh`。**ループのアカウント**と**PR の著者**を別々に答える。 */
  function withGh(options: { account?: string; author?: string; fails?: string }): void {
    writeFileSync(
      join(sandbox, "path", "gh"),
      [
        "#!/usr/bin/env bash",
        ...(options.fails === undefined
          ? []
          : [
              `if [[ $* == *${JSON.stringify(options.fails)}* ]]; then`,
              '  echo "gh が落ちた" >&2',
              "  exit 1",
              "fi",
            ]),
        // **ループが認証しているアカウント**（書き写さないための口）
        `if [[ $* == *"api user"* ]]; then printf '%s\\n' ${JSON.stringify(options.account ?? "")}; exit 0; fi`,
        `if [[ $* == *"pr view"* ]]; then printf '%s\\n' ${JSON.stringify(options.author ?? "")}; exit 0; fi`,
        'echo "スタブ: 想定外の gh 呼び出し: $*" >&2',
        "exit 2",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(join(sandbox, "path", "gh"), 0o755);
  }

  function run(args: string[] = ["12"]): { status: number; stdout: string; stderr: string } {
    const result = spawnSync(SCRIPT, args, {
      cwd: sandbox,
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(sandbox, "path")}:${process.env.PATH}` },
    });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  it("ループのアカウントが出した PR は、外ではない", () => {
    withGh({ account: "loop-account", author: "loop-account" });

    expect(run().status, "自分たちの PR を人待ちへ倒している").toBe(1);
  });

  it("別のアカウントが出した PR は、外である", () => {
    withGh({ account: "loop-account", author: "someone-else" });
    const result = run();

    expect(result.status).toBe(0);
    // **誰を待っているのかを出す。** 保留の理由に書けないと、**理由の無い保留**になる
    expect(result.stdout, "誰の PR かが出ていない").toContain("someone-else");
  });

  it("アカウントは書き写さない", () => {
    // **`gh` が認証しているアカウントから取る。** 名前を埋め込むと、
    // **別のアカウントで動かした瞬間、全部の PR が「外」になる**——
    // **ループ全体が人待ちで埋まる**
    withGh({ account: "another-account", author: "another-account" });

    expect(run().status, "認証しているアカウントを見ていない").toBe(1);
  });

  it("著者を読めなければ、どちらとも言わない", () => {
    // **判定不能を「外」に倒さない。** 倒すと、**worker の対応待ちが人待ちに化け**、
    // **誰も直さないまま保留だけが残る**
    withGh({ account: "loop-account", author: "someone-else", fails: "pr view" });

    expect(run().status).toBe(2);
  });

  it("アカウントを読めなければ、どちらとも言わない", () => {
    withGh({ account: "loop-account", author: "someone-else", fails: "api user" });

    expect(run().status).toBe(2);
  });

  it("空の答えを、一致とも不一致とも読まない", () => {
    // **`gh` は成功しながら空を返すことがある**（`bin/loop-head` で踏んだ形）。
    // **空同士を「一致」と読むと、外の PR が中として扱われる**
    withGh({ account: "", author: "" });

    expect(run().status).toBe(2);
  });

  it("アカウント名の形をしていないものは受けない", () => {
    // **外から来る文字列を、そのまま保留の本文へ戻さない**（`bin/loop-gate` と同じ判断）。
    // GitHub のログイン名は英数字とハイフンだけである
    withGh({ account: "loop-account", author: "someone else; rm -rf /" });

    expect(run().status).toBe(2);
  });

  it("使い方の誤りは 2", () => {
    withGh({ account: "loop-account", author: "someone-else" });

    expect(run([]).status).toBe(2);
    expect(run(["not-a-number"]).status).toBe(2);
  });
});
