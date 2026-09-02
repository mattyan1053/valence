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

  /**
   * **bot の著者を、名前の形で弾かない** (#562)。
   *
   * **実測（`gh` 2.86.0）**: `--json author` は bot を `app/dependabot` で返し、
   * REST（`repos/{owner}/{repo}/pulls/<N>`）は `dependabot[bot]` を返す
   * ——**`gh` の側が `app/` を付けている**ので、**どちらの形もこの口へ来る。**
   *
   * **弾くと、bot の不在が全体停止になる** (#70)。**dependabot は指摘に応えて
   * head を押し直さない**ので、**`awaiting-worker:<PR>@<sha>` の識別子が動かず、
   * 3 周で `loop/STOP`** に達する——**常駐している側まで止まる。**
   */
  it("bot の著者は、外である", () => {
    withGh({ account: "loop-account", author: "app/dependabot" });
    const result = run();

    expect(result.status, "bot を判定不能へ倒している").toBe(0);
    // **誰を待っているのかを出す**（保留の理由に書けないと、理由の無い保留になる）
    expect(result.stdout.trim(), "誰の PR かが出ていない").toBe("app/dependabot");
  });

  it("REST が返す形の bot も、外である", () => {
    // **同じ問いに 2 通りの形で答えが来る**——**口によって違う**（上のコメント）
    withGh({ account: "loop-account", author: "dependabot[bot]" });

    expect(run().status).toBe(0);
  });

  it("`app/` を通しても、判定不能まで飲み込まない", () => {
    // **緩めた範囲が、判定不能を「外」へ倒していないこと** (#562 の完了条件)。
    // **倒すと、worker の対応待ちが人待ちに化ける**——**誰も直さないまま保留が残る。**
    const unreadable = [
      "app/", // 前置きだけで、名前が無い
      "app/depend abot", // 空白入り
      `app/${"a".repeat(40)}`, // 長すぎる（ログイン名は 39 文字まで）
      "app/app/dependabot", // 前置きが 2 つ
      "/dependabot", // 前置きの形をしていない
      "app/dependabot; rm -rf /", // そのまま保留の本文へ戻さない
    ];

    for (const author of unreadable) {
      withGh({ account: "loop-account", author });

      expect(run().status, `判定不能を通している: ${author}`).toBe(2);
    }
  });

  /**
   * **名前だけで訊く口** (#559 のレビュー)。
   *
   * **一覧を持っている側は、PR 番号ではなく著者名を持っている**——**`bin/loop-open-work`
   * へ渡す一覧に著者の列がある**ので、**そこから訊けば `gh` を引き直さずに済む。**
   * **判定は写さない**——**アカウントの比べ方も、判定不能の倒し方も、ここが持つ。**
   */
  describe("--author（名前で訊く）", () => {
    it("ループのアカウントの名前は、外ではない", () => {
      withGh({ account: "loop-account" });

      expect(run(["--author", "loop-account"]).status, "自分たちを外にしている").toBe(1);
    });

    it("別のアカウントの名前は、外である", () => {
      withGh({ account: "loop-account" });
      const result = run(["--author", "someone-else"]);

      expect(result.status).toBe(0);
      expect(result.stdout, "誰の PR かが出ていない").toContain("someone-else");
    });

    it("PR を引き直さない", () => {
      // **番号を知らない口から呼ばれる**ので、**`gh pr view` を打つ余地が無い**
      // ——**打っていたら、ここで落ちる。**
      withGh({ account: "loop-account", fails: "pr view" });

      expect(run(["--author", "someone-else"]).status, "PR を引き直している").toBe(0);
    });

    it("アカウントを読めなければ、どちらとも言わない", () => {
      // **判定不能を「外」に倒さない**（番号で訊く側と同じ向き）
      withGh({ account: "loop-account", fails: "api user" });

      expect(run(["--author", "someone-else"]).status).toBe(2);
    });

    it("bot の名前でも訊ける", () => {
      // **一覧を持っている側が渡すのも `gh` の返した形**である（`app/dependabot`）
      withGh({ account: "loop-account" });
      const result = run(["--author", "app/dependabot"]);

      expect(result.status, "bot を判定不能へ倒している").toBe(0);
      expect(result.stdout.trim(), "誰の PR かが出ていない").toBe("app/dependabot");
    });

    it("名前の形をしていないものは受けない", () => {
      withGh({ account: "loop-account" });

      expect(run(["--author", "someone else; rm -rf /"]).status).toBe(2);
      expect(run(["--author", "app/"]).status, "前置きだけを通している").toBe(2);
      expect(run(["--author"]).status, "名前が無いのに通している").toBe(2);
      expect(run(["--author", "a", "b"]).status, "余った引数を黙って捨てている").toBe(2);
    });
  });

  it("使い方の誤りは 2", () => {
    withGh({ account: "loop-account", author: "someone-else" });

    expect(run([]).status).toBe(2);
    expect(run(["not-a-number"]).status).toBe(2);
  });
});
