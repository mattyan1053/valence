import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-review-commits", import.meta.url));

/** 現 head。祖先かどうかは compare の status で決まる。 */
const HEAD = "c".repeat(40);
/** レビュー用の bot（`--bot` が出す名前と同じ）。 */
const BOT = "chatgpt-codex-connector[bot]";
/** 現 head の祖先である commit（rebase されていない）。 */
const LIVE = "a".repeat(40);
/** rebase で消えた commit（現 head の祖先ではない）。 */
const STALE = "b".repeat(40);

type Run = { status: number; stdout: string; stderr: string };

describe("bin/loop-review-commits", () => {
  let repo: string;

  beforeAll(() => {
    // bin/loop-review-head --pair が git の共通ディレクトリを見るので、
    // 実リポジトリの記録を汚さないよう使い捨ての git リポジトリで動かす
    repo = mkdtempSync(join(tmpdir(), "loop-review-commits-"));
    expect(spawnSync("git", ["init", "--quiet", repo], { encoding: "utf8" }).status).toBe(0);
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  /**
   * gh を差し替えて動かす。**実 PR を rebase しなくても、祖先でない commit への
   * レビューがある状態を作れる。**
   */
  function run(args: string[], options: { compareFails?: boolean } = {}): Run {
    const dir = mkdtempSync(join(tmpdir(), "loop-review-commits-gh-"));
    symlinkSync("/usr/bin/bash", join(dir, "bash"));
    writeFileSync(
      join(dir, "gh"),
      [
        "#!/usr/bin/env bash",
        // **本文を返す。** 判定はスクリプト側で行わせる——**絞り込んだ後の行を返すと、
        // 判定を書き換えても緑のまま**になる（実際にそうなっていた）。
        // レビューは 2 件。片方は現 head の祖先、片方は rebase で消えた commit
        'if [[ $* == *"/pulls/12/reviews"* ]]; then',
        `  echo "2026-08-09T00:00:00Z\t${LIVE}\tReviewed commit: \\\`${LIVE.slice(0, 10)}\\\`"`,
        `  echo "2026-08-09T01:00:00Z\t${STALE}\tReviewed commit: \\\`${STALE.slice(0, 10)}\\\`"`,
        "  exit 0",
        "fi",
        'if [[ $* == *"/issues/12/comments"* || $* == *"/issues/12/reactions"* ]]; then',
        "  exit 0",
        "fi",
        'if [[ $* == *"pr view"* ]]; then',
        `  echo "${HEAD}"`,
        "  exit 0",
        "fi",
        'if [[ $* == *"/compare/"* ]]; then',
        ...(options.compareFails === true
          ? ['  echo "error connecting to api.github.com" >&2', "  exit 1"]
          : [
              // base が祖先なら ahead、そうでなければ diverged
              `  if [[ $* == *"${LIVE}..."* ]]; then echo ahead; exit 0; fi`,
              "  echo diverged",
              "  exit 0",
            ]),
        "fi",
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync(SCRIPT, args, {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
    });
    rmSync(dir, { recursive: true, force: true });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  it("現 head の祖先へのレビューは数える", () => {
    const result = run(["12"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(LIVE);
  });

  it("rebase で消えた commit へのレビューは数えない", () => {
    // 数えたままだと、上限に達した PR が「上限到達＋手直しが上限超え」に落ちて
    // **保留した PR が二度とマージできない**
    const result = run(["12"]);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(STALE);
  });

  it("--all は rebase で消えた commit へのレビューも返す", () => {
    // 「応答があったか」は rebase では消えない。ここを落とすと、応答済みの要求が
    // 未応答へ戻り、再レビューを要求できなくなる
    const result = run(["--all", "12"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(STALE);
    expect(result.stdout).toContain(LIVE);
  });

  it("--all は 1 回の取得で両方の軸を返す（live / stale を添える）", () => {
    // 呼び出し側が既定と --all を 2 回叩くと、その間に届いた応答で片方だけ新しい
    // 食い違った組み合わせになり、**レビュー上限を 1 回超えられる**
    const rows = run(["--all", "12"])
      .stdout.split("\n")
      .filter((line) => line !== "");

    expect(rows).toEqual([
      `2026-08-09T00:00:00Z\t${LIVE}\tlive`,
      `2026-08-09T01:00:00Z\t${STALE}\tstale`,
    ]);
  });

  describe("Codex が何を言っても、応答は応答として数える", () => {
    /**
     * **実データを写す**（#158 に残っていたもの）。**実在の PR を見に行かない**——
     * PR は消えうるし、**消えた日に「通っているのに何も試していない」**になる（#105）。
     */
    // **本文は 1 行に畳んで渡る**（jq の `gsub("\\s+"; " ")`）。実データの文言そのもの
    const WENT_WRONG =
      "Codex Review: Something went wrong. Try again later by commenting “@codex review”. " +
      "``` An unknown error occurred ```";

    /**
     * エラー応答と、そのあとの 👍 を返す偽の `gh`。
     *
     * **記録は 1 つだけ置く。** エラー応答が**記録を消費するかどうか**が、
     * そのまま 👍 の行き先に出る——**消費していれば、あとの 👍 は結び付く記録が無い**。
     */
    /**
     * **記録より後の時刻**を使う。`--pair` は **記録の時刻 ≤ 応答の時刻** でしか
     * 結び付けないので、**古い応答を渡すとそもそも対応付けが起きない**——
     * **判定を書き換えても緑のまま**になる（実際にそうなっていた）。
     */
    function laterThanNow(seconds: number): string {
      return new Date(Date.now() + seconds * 1_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    }

    /**
     * **試験ごとに PR 番号を変える。** 記録は PR ごとのファイルに積まれ、
     * `repo` は describe をまたいで共有されるので、**同じ番号を使うと前の試験の
     * 記録が残って結び付き先が変わる**（実際にそれで赤くなった）。
     */
    function withErrorReply(pr: number, body: string): Run {
      const dir = mkdtempSync(join(tmpdir(), "loop-review-commits-gh-"));
      symlinkSync("/usr/bin/bash", join(dir, "bash"));
      writeFileSync(
        join(dir, "gh"),
        [
          "#!/usr/bin/env bash",
          `if [[ $* == *"/pulls/${pr}/reviews"* ]]; then exit 0; fi`,
          `if [[ $* == *"/issues/${pr}/comments"* ]]; then`,
          `  printf '%s\\t%s\\t%s\\n' ${JSON.stringify(laterThanNow(60))} ${JSON.stringify(BOT)} ${JSON.stringify(body)}`,
          "  exit 0",
          "fi",
          `if [[ $* == *"/issues/${pr}/reactions"* ]]; then`,
          `  printf '%s\\t\\n' ${JSON.stringify(laterThanNow(120))}`,
          "  exit 0",
          "fi",
          'if [[ $* == *"pr view"* ]]; then',
          `  echo "${HEAD}"`,
          "  exit 0",
          "fi",
          'if [[ $* == *"/compare/"* ]]; then echo ahead; exit 0; fi',
          "exit 1",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const result = spawnSync(SCRIPT, [String(pr)], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      });
      rmSync(dir, { recursive: true, force: true });
      return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
    }

    it("エラー応答が記録を消費するので、あとの 👍 は結び付かない", () => {
      // **落とすと記録が消費されずに残り、あとから来た 👍 がそこへ吸われる**——
      // **誰も見ていない head が「レビュー済み」になる**（スクリプト冒頭の経緯）。
      // **一覧に無い文言だけが落とされていた**ので、**この道だけが開いていた**
      const head = fileURLToPath(new URL("./loop-review-head", import.meta.url));
      expect(
        spawnSync(head, ["42", HEAD], { cwd: repo, encoding: "utf8" }).status,
        "記録を置けない",
      ).toBe(0);

      const listed = withErrorReply(42, WENT_WRONG);

      expect(listed.status).toBe(0);
      expect(listed.stdout, "エラー応答が落とされ、👍 が記録を吸っている").not.toContain(HEAD);
    });

    /** `--answers` の出力（応答として数えた時刻）。 */
    function answersOf(pr: number, comments: { login: string; body: string }[]): string {
      const dir = mkdtempSync(join(tmpdir(), "loop-review-commits-gh-"));
      symlinkSync("/usr/bin/bash", join(dir, "bash"));
      const rows = comments
        .map((comment, index) => `${laterThanNow(60 + index)}\t${comment.login}\t${comment.body}`)
        .join("\n");
      writeFileSync(
        join(dir, "gh"),
        [
          "#!/usr/bin/env bash",
          `if [[ $* == *"/issues/${pr}/comments"* ]]; then`,
          // **ヒアドキュメントで渡す。** `printf '%b' "…"` だと**本文のバッククォートが
          // コマンド置換になり**、`Reviewed commit: \`sha\`` が空になる——
          // **実物は正しいのに試験だけが落ちる**（実際に踏んだ）
          "  cat <<'ROWS'",
          rows,
          "ROWS",
          "  exit 0",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const result = spawnSync(SCRIPT, ["--answers", String(pr)], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      });
      rmSync(dir, { recursive: true, force: true });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    }

    it("知らない断り文句でも、応答として数える", () => {
      // **文言の列挙へ戻さない**（#159）。**列挙から漏れたものが「応答なし」に落ちると、
      // `pending` が減らず再要求が永久に禁じられる**——昨夜これで 2 時間止まった
      const answers = answersOf(50, [{ login: BOT, body: "まだ誰も見たことのない断り文句" }]);

      expect(answers.trim(), "知らない文言を落としている").not.toBe("");
    });

    it("レビュー以外の Codex タスクへの応答は、数えない", () => {
      // **本文に `@codex` が混ざると、レビューを頼んでいないのに bot が答える**
      // （`AGENTS.md` にこの経路そのものが書いてある）。**それを数えると、
      // 記録を消費して未レビューの head を通し、`pending` も勝手に解除される**。
      // **文言では見分けられない**ので、**引き金の側と対応させる**
      const answers = answersOf(51, [
        { login: "mattyan1053", body: "説明のために @codex と書いてしまった" },
        { login: BOT, body: "To use Codex here, create an environment" },
      ]);

      expect(answers.trim(), "無関係な応答を数えている").toBe("");
    });

    it("要求そのものは、引き金に数えない", () => {
      // **`@codex review` を混入に数えると、要求のたびに応答が 1 つ食われる**——
      // **本物の応答が届いても解けない**（#159 の塞がりへ戻る）
      const answers = answersOf(52, [
        { login: "mattyan1053", body: "@codex review" },
        { login: BOT, body: "Codex Review: Something went wrong." },
      ]);

      expect(answers.trim(), "要求を引き金に数えている").not.toBe("");
    });

    it("印を持つ応答は、混入があってもレビューである", () => {
      // **自分でレビューだと名乗っている**ものまで落とすと、**きれいな PR ほど
      // マージできない**（この仕組みが最初に踏んだ逆転）
      const answers = answersOf(53, [
        { login: "mattyan1053", body: "@codex" },
        { login: BOT, body: `Reviewed commit: \`${LIVE.slice(0, 10)}\`` },
      ]);

      expect(answers.trim(), "印を持つ応答を落としている").not.toBe("");
    });

    it("印を持たない応答は、レビューとして数えない", () => {
      // **すべてを応答として数えるが、すべてをレビューにはしない。**
      // ここが緩むと、**中身の無い応答で「レビュー済み」になり、
      // 誰も見ていない head がマージ可能**になる——**この仕組みが最初に塞いだ穴**である。
      // 本文に SHA らしい並びが混ざっていても、**印が無ければレビューではない**
      const head = fileURLToPath(new URL("./loop-review-head", import.meta.url));
      expect(spawnSync(head, ["43", HEAD], { cwd: repo, encoding: "utf8" }).status).toBe(0);

      const listed = withErrorReply(43, `エラーが起きました (${LIVE})`);

      expect(listed.status).toBe(0);
      expect(listed.stdout, "印の無い応答をレビューとして数えている").toBe("");
    });
  });

  it("祖先か判定できないときは失敗にする", () => {
    // 数え落として「未レビュー」に見えるほうが安全
    const result = run(["12"], { compareFails: true });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("祖先か判定できません");
  });
});

describe("bin/loop-review-commits --bot", () => {
  /** bash だけを置いた PATH。gh がここに無いので、到達すれば別の失敗になる。 */
  function runBot(args: string[]): Run {
    const dir = mkdtempSync(join(tmpdir(), "loop-review-bot-"));
    symlinkSync("/usr/bin/bash", join(dir, "bash"));
    const result = spawnSync(SCRIPT, args, {
      encoding: "utf8",
      env: { ...process.env, PATH: dir },
    });
    rmSync(dir, { recursive: true, force: true });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  it("gh を呼ばずにレビュー用の bot 名を出す", () => {
    // **値の正をここ 1 箇所にする。** 他のスクリプトが「誰のレビューか」を
    // 判定するとき、**書き写すと片方だけ直して食い違う**
    const result = runBot(["--bot"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).not.toBe("");
  });

  it("引数を足すと使い方を出して落ちる", () => {
    expect(runBot(["--bot", "12"]).status).toBe(2);
  });

  it("同じ bot を固定している他のスクリプトと食い違わない", () => {
    // **既に 4 箇所にある。** 一致していることを試験で押さえておかないと、
    // 片方だけ直したときに **「誰のレビューか」の判定がスクリプトごとにずれる**
    const bot = runBot(["--bot"]).stdout.trim();
    const read = (path: string): string =>
      readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

    expect(read("bin/loop-gate")).toContain(`REVIEW_BOT="${bot}"`);
    expect(read("bin/loop-review-budget")).toContain(`REVIEW_BOT="${bot}"`);
    // **GraphQL は `[bot]` を付けずに返す**（REST は付ける）。bin/loop-handoff は
    // GraphQL で読むので、意図的にそちらの形を持っている
    expect(bot).toMatch(/\[bot\]$/);
    expect(read("bin/loop-handoff")).toContain(`REVIEW_BOT="${bot.replace(/\[bot\]$/, "")}"`);
  });
});
