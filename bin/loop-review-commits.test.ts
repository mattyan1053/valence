import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-review-commits", import.meta.url));

/** 現 head。祖先かどうかは compare の status で決まる。 */
const HEAD = "c".repeat(40);
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
        // レビューは 2 件。片方は現 head の祖先、片方は rebase で消えた commit
        'if [[ $* == *"/pulls/12/reviews"* ]]; then',
        `  echo "2026-08-09T00:00:00Z\t${LIVE}"`,
        `  echo "2026-08-09T01:00:00Z\t${STALE}"`,
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

  it("祖先か判定できないときは失敗にする", () => {
    // 数え落として「未レビュー」に見えるほうが安全
    const result = run(["12"], { compareFails: true });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("祖先か判定できません");
  });
});
