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

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-review-reply", import.meta.url));

const THREAD = "PRRT_test";

/** 役の印。**書く側から引く**（試験にも写さない）。 */
function markOf(role: string): string {
  const result = spawnSync(SCRIPT, ["--mark", role], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}
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
  /** ロックを握らせておく相手（`lockHeld` のときだけ起こす）。 */
  let holder: ReturnType<typeof spawn> | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "loop-review-reply-"));
  });

  afterEach(() => {
    holder?.kill();
    holder = undefined;
    // **毎回捨てる。** 残すと、次の試験が前の答えを読む
    rmSync(sandbox, { recursive: true, force: true });
  });

  /**
   * `gh` の差し替え。**本物と同じところで落ちる形にしておく**——
   * **`-F b=@…` はファイル読み込みとして解釈され、API を叩く前に落ちる。**
   */
  function ghStub(
    options: { pendings?: Pending[]; me?: string },
    paths: { outcomes: string; deleted: string; posts: string; passed: string },
  ): string {
    return [
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
      `  printf '%s\\n' "$args" >> ${JSON.stringify(paths.deleted)}`,
      "  exit 0",
      "fi",
      // **返信の投稿**
      'if [[ $args == *"addPullRequestReviewThreadReply"* ]]; then',
      `  printf '%s\\n' "$args" >> ${JSON.stringify(paths.passed)}`,
      '  if [[ $args == *"-F b=@"* || $args == *"-F t=@"* ]]; then',
      '    echo "could not open file" >&2',
      "    exit 1",
      "  fi",
      `  printf 'x\\n' >> ${JSON.stringify(paths.posts)}`,
      `  outcome="$(head -1 ${JSON.stringify(paths.outcomes)})"`,
      `  sed -i '1d' ${JSON.stringify(paths.outcomes)}`,
      '  case "$outcome" in',
      "    ok) printf '%s\\n' \"https://example.test/pull/1#discussion_r1\"; exit 0 ;;",
      `    blocked) echo ${JSON.stringify(BLOCKED)} >&2; exit 1 ;;`,
      '    *) echo "べつの理由" >&2; exit 1 ;;',
      "  esac",
      "fi",
      'echo "スタブ: 想定外の呼び出し: $args" >&2',
      "exit 1",
      "",
    ].join("\n");
  }

  /**
   * 別の周回にロックを握らせる。
   *
   * **握ったことを待ってから返す。** **起こしただけでは、検査対象のほうが先に
   * 取ることがある**——**そのとき「消さない」は偶然になり、たまに落ちる試験になる**
   * （#225 のレビュー）。
   */
  function holdLock(lock: string, ready: string): void {
    writeFileSync(lock, "");
    holder = spawn("flock", ["-x", lock, "sh", "-c", `touch ${JSON.stringify(ready)}; sleep 30`], {
      stdio: "ignore",
    });
    const until = Date.now() + 10_000;
    while (!existsSync(ready)) {
      if (Date.now() > until) {
        throw new Error("ロックを握らせられませんでした");
      }
      spawnSync("sleep", ["0.05"]);
    }
  }

  function run(options: {
    /** 投稿の結果を、呼ばれた順に並べる。`ok` は成功、`blocked` は 422。 */
    replies: ("ok" | "blocked" | "other")[];
    /** `reviews` が返す一覧。 */
    pendings?: Pending[];
    /** `gh api user` が返す login。 */
    me?: string;
    /** 返信の本文。**渡し方を見るために差し替える。** */
    body?: string;
    /** ロックを別の周回が握っている状態にする。 */
    lockHeld?: boolean;
    /** 役の印。**渡さないときの既定は worker**（試験の都合。実装では必須である） */
    role?: string[];
  }): {
    status: number;
    stdout: string;
    stderr: string;
    deleted: string;
    posts: number;
    passed: string;
  } {
    const stub = join(sandbox, "stub");
    mkdirSync(stub, { recursive: true });
    const body = join(sandbox, "reply.md");
    writeFileSync(body, `${options.body ?? "直しました。"}\n`);
    const passed = join(sandbox, "passed");
    const outcomes = join(sandbox, "outcomes");
    writeFileSync(outcomes, `${options.replies.join("\n")}\n`);
    const deleted = join(sandbox, "deleted");
    const posts = join(sandbox, "posts");
    writeFileSync(join(stub, "gh"), ghStub(options, { outcomes, deleted, posts, passed }), {
      mode: 0o755,
    });

    const lock = join(sandbox, "reply.lock");
    if (options.lockHeld === true) {
      holdLock(lock, join(sandbox, "lock-held"));
    }
    const result = spawnSync(SCRIPT, [...(options.role ?? ["worker"]), "42", THREAD, body], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${stub}:${process.env.PATH}`,
        LOOP_REVIEW_REPLY_LOCK: lock,
        LOOP_REVIEW_REPLY_LOCK_WAIT_SEC: "1",
      },
    });
    return {
      status: result.status ?? -1,
      stdout: result.stdout,
      stderr: result.stderr,
      deleted: existsSync(deleted) ? readFileSync(deleted, "utf8") : "",
      posts: existsSync(posts) ? readFileSync(posts, "utf8").trim().split("\n").length : 0,
      passed: existsSync(passed) ? readFileSync(passed, "utf8") : "",
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
    // **投げるのは 3 回**（初回 / 錠を取った直後 / 消した直後）。**理由がそれぞれ違う。**
    const result = run({
      replies: ["blocked", "blocked", "ok"],
      pendings: [{ id: 7, login: "me", body: "", comments: 0 }],
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.deleted, "消していない").toContain("/reviews/7");
    expect(result.posts, "投げ直していない").toBe(3);
  });

  it("下書きが入った pending は消さない", () => {
    // **消すと、書いた内容ごと消える。** **止まるほうへ倒す。**
    const result = run({
      replies: ["blocked", "blocked"],
      pendings: [{ id: 7, login: "me", body: "書きかけ", comments: 0 }],
    });

    expect(result.status).toBe(1);
    expect(result.deleted, "書きかけを消している").toBe("");
    expect(result.stderr).toContain("7");
  });

  it("提出済みのコメントが入った pending は消さない", () => {
    // **本文が空でも、コメントが下書きされていることがある**——**両方見る。**
    const result = run({
      replies: ["blocked", "blocked"],
      pendings: [{ id: 7, login: "me", body: "", comments: 3 }],
    });

    expect(result.status).toBe(1);
    expect(result.deleted, "下書きのコメントごと消している").toBe("");
  });

  it("自分のものでない pending は消さない", () => {
    const result = run({
      replies: ["blocked", "blocked"],
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
    // **錠を取ったあとも塞がれたまま**なのに、pending が 1 つも無い状態
    const result = run({ replies: ["blocked", "blocked"], pendings: [] });

    expect(result.status).toBe(2);
    expect(result.deleted).toBe("");
  });

  it("本文は、型を変えずに渡す", () => {
    // **`-F` は型を変える。** **`@` で始まる本文はファイル名として読まれ**、
    // **`false` や整数だけの本文は別の型になる**——**渡すのは利用者が書いた文字列**で、
    // **変えてよいものではない。**
    //
    // **「投稿できた」だけを見ない。** **通ったことだけ見ると、`-F` に戻しても緑**である。
    const result = run({ replies: ["ok"] });

    expect(result.passed, "-F で渡している（型が変わる）").not.toContain("-F b=");
    expect(result.passed).toContain("-f b=");
    expect(result.passed, "スレッド ID も型を変えて渡している").not.toContain("-F t=");
  });

  it("印は、投稿する本文の中に入る", () => {
    // **印は投稿する側が必ず付ける** (#174)。**本文へ書けと手順書に書く形にすると、
    // 付け忘れがそのまま誤認になる**——**スクリプトが付ける。**
    const posted = run({ replies: ["ok"], role: ["worker"], body: "直しました。" });

    expect(posted.status, posted.stderr).toBe(0);
    expect(posted.passed, "本文が渡っていない").toContain("直しました。");
    expect(posted.passed, "役の印が入っていない").toContain(markOf("worker"));
  });

  it("`@` で始まる本文でも投稿できる", () => {
    // **落ちると、症状は「pending review が原因ではありません」**になる
    // ——**原因は本文の 1 文字目なのに、そう読める文面はどこにも出ない。**
    // **このスクリプトが塞ごうとしている形そのもの**である。
    const result = run({ replies: ["ok"], body: "@codex の指摘に答えます" });

    expect(result.status, result.stderr).toBe(0);
  });

  it("ロックを取れなければ、消さない", () => {
    // **確かめてから消すまでの間に、下書きが 1 件入ると、それごと消える。**
    // **GitHub は 1 人 1 つしか pending を持たせない**ので、**master と worker が
    // 同じアカウントで見ているのは同じ 1 つ**である（#174）。
    //
    // **取れなかったら消さない。** **「取れた」経路の緑では、ここは見えない。**
    const result = run({
      replies: ["blocked"],
      pendings: [{ id: 7, login: "me", body: "", comments: 0 }],
      lockHeld: true,
    });

    expect(result.status).toBe(2);
    expect(result.deleted, "ロックを取れないまま消している").toBe("");
  });

  it("塞がれていない投稿は、ロックを待たない", () => {
    // **錠は広く取らない。** **普通の返信が、別の周回の始末を待つ理由は無い。**
    const result = run({ replies: ["ok"], lockHeld: true });

    expect(result.status, result.stderr).toBe(0);
  });

  it("待っている間に片付いていたら、消さずに投稿できる", () => {
    // **ロックを待つ間に、先に入った周回が消して投げ直している**ことがある
    // ——**そのとき塞いでいるものはもう無い**（#225 のレビュー）。
    // **待つ前に読んだ理由のまま進むと、「pending が見つかりません」で
    // 投稿できずに終わる。** **錠を取ったら、もう一度やってみる。**
    const result = run({ replies: ["blocked", "ok"], pendings: [] });

    expect(result.status, result.stderr).toBe(0);
    expect(result.deleted, "消しに行っている").toBe("");
    expect(result.posts, "投げ直していない").toBe(2);
  });

  it("消しても塞がれたままなら、そこで止める", () => {
    // **際限なく投げない。** 投げるのは **最初の 1 回・錠を取った直後・消した直後**
    // の 3 回までで、**どれも理由が違う**（初回 / 待つ間に変わりうる / 片付けた）。
    const result = run({
      replies: ["blocked", "blocked", "blocked"],
      pendings: [{ id: 7, login: "me", body: "", comments: 0 }],
    });

    expect(result.status).toBe(2);
    expect(result.posts, "4 回以上投げている").toBe(3);
  });
});

/**
 * **置き場所を片方だけにしない** (#216)。
 *
 * **master も worker も返信を投稿する。** **散文で片方にだけ書くと、
 * もう片方が同じところで詰まる**——**実際に、同じ手を 2 回、記憶で打っている。**
 */
describe("投稿した役が、GitHub 側から読める", () => {
  // **master と worker は同じ GitHub アカウントで動く**ので、**発言から役を
  // 見分けられない** (#174)。**`bin/loop-handoff` は「呼んだ側は書き終えている」で
  // 代用していた**が、**それは前提であって事実ではない**——**worker の返信を
  // master の判断として読むと、当否が判断されていない指摘が「判断済み」に落ちる**
  // （**通す側へ倒れるので気づきにくい**）。
  //
  // **印は投稿する側が必ず付ける。** **「付け忘れたら master 扱い」のような既定を
  // 置くと、付け忘れがそのまま誤認になる**ので、**役は引数で必ず受け取る。**

  it("役を渡さなければ、使い方の誤りで落ちる", () => {
    const result = spawnSync(SCRIPT, ["42", THREAD, "/dev/null"], { encoding: "utf8" });

    expect(result.status, "役なしで通ってしまう").toBe(2);
    expect(result.stderr, "使い方が出ていない").toContain("使い方");
  });

  it("知らない役は受け付けない", () => {
    const result = spawnSync(SCRIPT, ["reviewer", "42", THREAD, "/dev/null"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(2);
  });

  it("役ごとに違う印になる", () => {
    expect(markOf("worker"), "役で分かれていない").not.toBe(markOf("master"));
  });

  it("印は、読む側から引ける", () => {
    // **2 箇所に持たない**（#159 の形）。**書く側と読む側が同じ文字列を持つと、
    // 片方だけ直したときに黙って食い違う**——**読む側はここへ訊く**
    const asked = spawnSync(SCRIPT, ["--mark", "worker"], { encoding: "utf8" });

    expect(asked.status, asked.stderr).toBe(0);
    expect(asked.stdout.trim()).not.toBe("");
  });
});

describe("返信の投稿口は、両方の役から辿れる", () => {
  const ROOT = fileURLToPath(new URL("..", import.meta.url));

  for (const doc of [
    "loop/procedure/worker.md",
    ".claude/commands/loop-master.md",
    ".claude/skills/respond-to-review/SKILL.md",
  ]) {
    it(`${doc} が投稿口を指している`, () => {
      expect(readFileSync(join(ROOT, doc), "utf8")).toContain("bin/loop-review-reply");
    });
  }
});
