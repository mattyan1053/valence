/**
 * **投稿が落ちた残骸が、次の投稿を全部塞ぐ** (#216)。
 *
 * **502 で落ちた投稿は、空の pending review を 1 つ残す。** **以後の返信は
 * すべて 422 になる**——**文面は「1 人 1 つしか pending を持てない」**なので、
 * **読むと「2 つ目を書こうとしている」に見えるが、実際は「1 つ目が空のまま
 * 残っている」**である。**#215 と #224 で 2 回踏み、2 回とも記憶で直した。**
 *
 * **消す側だけを書かない。** **提出済みのコメントが入った pending を消すと、
 * 書いた内容ごと消える**——**中身を確かめてから消す。**
 *
 * **判断はここが持つ。** **master も worker も返信を投稿する**ので、
 * **散文で片方にだけ書くと、もう片方が同じところで詰まる。**
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-review-reply", import.meta.url));

const THREAD = "PRRT_test";
const BLOCKED = "user_id can only have one pending review per pull request";

/** pending review 1 件ぶんの答え。 */
type Pending = {
  id: number;
  login: string;
  /** 下書きの本文。**空でなければ消さない。** */
  body?: string;
  /** 提出済みコメントの件数。**0 でなければ消さない。** */
  comments?: number;
};

describe("bin/loop-review-reply", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "loop-review-reply-"));
  });

  afterEach(() => {
    // **毎回捨てる。** 残すと、次の試験が前の答えを読む
    rmSync(sandbox, { recursive: true, force: true });
  });

  function run(options: {
    /** 投稿の結果を、呼ばれた順に並べる。`ok` は成功、`blocked` は 422。 */
    replies: ("ok" | "blocked" | "other")[];
    /** `reviews` が返す一覧。 */
    pendings?: Pending[];
    /** `gh api user` が返す login。 */
    me?: string;
  }): { status: number; stdout: string; stderr: string; deleted: string; posts: number } {
    const stub = join(sandbox, "stub");
    mkdirSync(stub, { recursive: true });
    const body = join(sandbox, "reply.md");
    writeFileSync(body, "直しました。\n");
    const outcomes = join(sandbox, "outcomes");
    writeFileSync(outcomes, `${options.replies.join("\n")}\n`);
    const deleted = join(sandbox, "deleted");
    const posts = join(sandbox, "posts");
    writeFileSync(
      join(stub, "gh"),
      [
        "#!/usr/bin/env bash",
        'args="$*"',
        // **誰が投稿しているか**
        'if [[ $args == "api user"* ]]; then',
        `  printf '%s\\n' ${JSON.stringify(options.me ?? "me")}`,
        "  exit 0",
        "fi",
        // **pending review の一覧。** **`--jq` は列を取り出すだけ**で、
        // **選ぶのはスクリプト側**——**そこを試験から動かせるようにしてある**
        // （`jq` が無いので、スタブは式を解釈できない。#135 と同じ形）
        'if [[ $args == *"/reviews"* && $args != *"/reviews/"* ]]; then',
        '  for frag in ".id" ".state" ".user.login" ".body"; do',
        '    if [[ $args != *"$frag"* ]]; then',
        '      echo "スタブ: $frag を問い合わせていない: $args" >&2',
        "      exit 1",
        "    fi",
        "  done",
        ...(options.pendings ?? []).map(
          (pending) =>
            `  printf '%s\\t%s\\t%s\\t%s\\n' ${pending.id} PENDING ${JSON.stringify(pending.login)} ${(pending.body ?? "").length}`,
        ),
        "  exit 0",
        "fi",
        // **その pending が持つ提出済みコメントの件数**
        ...(options.pendings ?? []).map(
          (pending) =>
            `if [[ $args == *"/reviews/${pending.id}/comments"* ]]; then printf '%s\\n' ${pending.comments ?? 0}; exit 0; fi`,
        ),
        // **削除**（何を消したかを残す）
        'if [[ $args == *"--method DELETE"* || $args == *"-X DELETE"* ]]; then',
        `  printf '%s\\n' "$args" >> ${JSON.stringify(deleted)}`,
        "  exit 0",
        "fi",
        // **返信の投稿**
        'if [[ $args == *"addPullRequestReviewThreadReply"* ]]; then',
        `  printf 'x\\n' >> ${JSON.stringify(posts)}`,
        `  outcome="$(head -1 ${JSON.stringify(outcomes)})"`,
        `  sed -i '1d' ${JSON.stringify(outcomes)}`,
        '  case "$outcome" in',
        "    ok) printf '%s\\n' \"https://example.test/pull/1#discussion_r1\"; exit 0 ;;",
        `    blocked) echo ${JSON.stringify(BLOCKED)} >&2; exit 1 ;;`,
        '    *) echo "べつの理由" >&2; exit 1 ;;',
        "  esac",
        "fi",
        'echo "スタブ: 想定外の呼び出し: $args" >&2',
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync(SCRIPT, ["42", THREAD, body], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
    });
    return {
      status: result.status ?? -1,
      stdout: result.stdout,
      stderr: result.stderr,
      deleted: existsSync(deleted) ? readFileSync(deleted, "utf8") : "",
      posts: existsSync(posts) ? readFileSync(posts, "utf8").trim().split("\n").length : 0,
    };
  }

  it("通ったら、投稿先を出して終わる", () => {
    const result = run({ replies: ["ok"] });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("discussion_r1");
    // **通ったときに pending を探しに行かない。** 消す経路へ近づけない
    expect(result.deleted, "消しに行っている").toBe("");
    expect(result.posts).toBe(1);
  });

  it("塞がれていたら、空の pending を消して投げ直す", () => {
    const result = run({
      replies: ["blocked", "ok"],
      pendings: [{ id: 7, login: "me", body: "", comments: 0 }],
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.deleted, "消していない").toContain("/reviews/7");
    expect(result.posts, "投げ直していない").toBe(2);
  });

  it("下書きが入った pending は消さない", () => {
    // **消すと、書いた内容ごと消える。** **止まるほうへ倒す。**
    const result = run({
      replies: ["blocked"],
      pendings: [{ id: 7, login: "me", body: "書きかけ", comments: 0 }],
    });

    expect(result.status).toBe(1);
    expect(result.deleted, "書きかけを消している").toBe("");
    expect(result.stderr).toContain("7");
  });

  it("提出済みのコメントが入った pending は消さない", () => {
    // **本文が空でも、コメントが下書きされていることがある**——**両方見る。**
    const result = run({
      replies: ["blocked"],
      pendings: [{ id: 7, login: "me", body: "", comments: 3 }],
    });

    expect(result.status).toBe(1);
    expect(result.deleted, "下書きのコメントごと消している").toBe("");
  });

  it("自分のものでない pending は消さない", () => {
    const result = run({
      replies: ["blocked"],
      pendings: [{ id: 7, login: "someone-else", body: "", comments: 0 }],
    });

    expect(result.status).toBe(1);
    expect(result.deleted, "他人の pending を消している").toBe("");
  });

  it("塞がれていないのに落ちたら、pending を疑わない", () => {
    // **「422 なら pending」だけを覚えると、別の理由で落ちたときに同じ手を打つ。**
    const result = run({ replies: ["other"], pendings: [{ id: 7, login: "me", comments: 0 }] });

    expect(result.status).toBe(2);
    expect(result.deleted, "関係のない pending を消している").toBe("");
    expect(result.posts, "投げ直している").toBe(1);
  });

  it("塞がれているのに pending が見つからなければ、消さずに報告する", () => {
    const result = run({ replies: ["blocked"], pendings: [] });

    expect(result.status).toBe(2);
    expect(result.deleted).toBe("");
  });

  it("投げ直しても塞がれていたら、繰り返さない", () => {
    // **同じ手を繰り返すと、同じ競合をもう一度開く**（`ensureUsableToken` と同じ判断）。
    const result = run({
      replies: ["blocked", "blocked"],
      pendings: [{ id: 7, login: "me", body: "", comments: 0 }],
    });

    expect(result.status).toBe(2);
    expect(result.posts, "3 回以上投げている").toBe(2);
  });
});

/**
 * **置き場所を片方だけにしない** (#216)。
 *
 * **master も worker も返信を投稿する。** **散文で片方にだけ書くと、
 * もう片方が同じところで詰まる**——**実際に、同じ手を 2 回、記憶で打っている。**
 */
describe("返信の投稿口は、両方の役から辿れる", () => {
  const ROOT = fileURLToPath(new URL("..", import.meta.url));

  for (const doc of [
    ".claude/commands/loop-worker.md",
    ".claude/commands/loop-master.md",
    ".claude/skills/respond-to-review/SKILL.md",
  ]) {
    it(`${doc} が投稿口を指している`, () => {
      expect(readFileSync(join(ROOT, doc), "utf8")).toContain("bin/loop-review-reply");
    });
  }
});
