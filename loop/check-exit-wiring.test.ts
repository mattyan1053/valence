import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { procedureText } from "./procedure-doc";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TASK = join(REPO_ROOT, "task");

/** 節ごとの bash ブロック。 */
function blocks(): { section: string; body: string }[] {
  const found: { section: string; body: string }[] = [];
  let section = "";
  let body: string[] | undefined;
  for (const line of procedureText("worker").split("\n")) {
    if (/^#{2,4} /.test(line)) {
      section = line.trim();
    }
    if (line.startsWith("```")) {
      if (body !== undefined) {
        found.push({ section, body: body.join("\n") });
      }
      body = line.startsWith("```bash") ? [] : undefined;
      continue;
    }
    body?.push(line);
  }
  return found;
}

/**
 * **`./task check` を打つブロックを、全部並べる。**
 *
 * **1 つだけ返さない。** `find` で 1 つ取ると**名指しと同じ**になり、
 * **打つところが増えても気づけない**——**#166 / #168 と同じ形を 3 回続けて踏んだ**
 * （直した場所の隣が抜ける）。**「打つところで見る」に直しても、
 * 「打つところが 1 つとは限らない」は別の話**である。
 */
function checkBlocks(): { section: string; body: string }[] {
  // **`check:` の付いた別の口を数えない** (#552)。**`./task check:leftovers` は
  // 打つ前に見る口**、**`./task check:wait` は走っているものに付き直す口**であって、
  // **どちらも check を走らせない**——**走らせない節に「印を見ろ」は当たらない。**
  //
  // **緩めているのではない。** **数えたいのは「走らせる節」**で、
  // **走らせる節はこれまでどおり全部並ぶ**（**下の期待値がそれを押さえる**）。
  return blocks().filter((block) => /\.\/task check(\s|$)/m.test(block.body));
}

/**
 * `./task check` が殺されると、終了コードが無いまま出力が緑に見える（#147）。
 *
 * **実際に起きた**（2026-08-11、PR #142 の周回）——**ログはテストが緑で進む様子だけ**、
 * **終了コードは出ないまま push した**。**殺されたときの出力は、成功したときの出力の
 * 途中まで**なので、**目で見ると緑に見える**。
 *
 * **#121 が入れたのは「出力ではなく終了コードで決める」**で、
 * **「終了コードが存在しない」は守っていない**——**その隣の穴**である。
 *
 * **時間とともに踏みやすくなる。** 試験は増える一方で、**1 vCPU の VM** では
 * `./task check` が長くなり続ける——**長くなるほど、緑に見える確率が上がる**。
 *
 * **殺さないと 1 度も通らない。** **正常に終わる周回だけを見ると、
 * 何もしなくても緑**になる。
 */
describe("./task check の終わりの印", () => {
  it("走り終えたら、合否を最後の 1 行で言う", () => {
    const result = runCheck("return 0");

    expect(result.stdout, "終わりの印が出ていない").toContain("check-exit=0");
    expect(result.status, "終了コードを伝えていない").toBe(0);
  });

  it("落ちたときも、印と終了コードは合う", () => {
    // **印だけを見て緑と読ませない。** **印には合否が入っている**
    const result = runCheck("return 3");

    expect(result.stdout).toContain("check-exit=3");
    expect(result.status).toBe(3);
  });

  it("殺されたら、印が出ない", () => {
    // **これが本命である。** **本当に殺して**確かめる——**印が「全部走り終えた」ことを
    // 表しているか**は、**途中で殺しても最後の 1 行だけ出る形**にすると意味が無い
    const result = runCheck("sleep 30", 1);

    expect(result.stdout, "殺されたのに走り終えた顔をしている").not.toContain("check-exit");
    expect(result.status, "timeout に殺されていない").not.toBe(0);
  });

  /**
   * **`./task check` を、写した checkout の中で走らせる**（#375）。
   *
   * **実物の `.git` へ記録を書かせない** (#186)——**走らせた回数ぶん、
   * この作業場の commit の可否が動く**（**実際に動いた**——**`sleep 30` を殺す試験が、
   * 本物の記録へ「走っている」を書き残し、こちらの commit が止まった**）。
   *
   * **コンテナも起こさない**——**見たいのは合否の伝え方**であって、検査の中身ではない。
   */
  function runCheck(
    exec: string,
    timeoutSec?: number,
    options: { seed?: string; breakRecorder?: boolean; ensureUp?: string } = {},
  ): { status: number; stdout: string; verdict: number } {
    const sandbox = mkdtempSync(join(tmpdir(), "check-state-wiring-"));
    try {
      expect(spawnSync("git", ["init", "--quiet", sandbox]).status).toBe(0);
      mkdirSync(join(sandbox, "bin"), { recursive: true });
      copyFileSync(TASK, join(sandbox, "task"));
      copyFileSync(join(REPO_ROOT, "bin/loop-check-state"), join(sandbox, "bin/loop-check-state"));
      // **`cmd_check` は、記録の名前を `bin/loop-lease` に訊く** (#403 のレビュー)
      // ——**この砂場にも実物を置く**（**無いと「読めない」で落ちる**）
      copyFileSync(join(REPO_ROOT, "bin/loop-lease"), join(sandbox, "bin/loop-lease"));
      chmodSync(join(sandbox, "task"), 0o755);
      chmodSync(join(sandbox, "bin/loop-check-state"), 0o755);
      chmodSync(join(sandbox, "bin/loop-lease"), 0o755);
      if (options.seed !== undefined) {
        // **前の走りの記録**（**「前の緑が残る」を入力に置く**）
        const dir = join(sandbox, ".git", "valence-check-state.d");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "前の走り"), `${options.seed}\n`);
      }
      if (options.breakRecorder === true) {
        // **記録できない**（置き場所が読めない・スクリプトが落ちる）
        writeFileSync(join(sandbox, "bin/loop-check-state"), "#!/usr/bin/env bash\nexit 2\n", {
          mode: 0o755,
        });
      }
      const body = [
        `source ${JSON.stringify(join(sandbox, "task"))} >/dev/null 2>&1`,
        `ensure_up() { ${options.ensureUp ?? ":"}; }`,
        `exec_app() { ${exec}; }`,
        "cmd_check",
      ].join("; ");
      const run =
        timeoutSec === undefined
          ? spawnSync("bash", ["-c", body], { cwd: sandbox, encoding: "utf8" })
          : spawnSync("timeout", [`${timeoutSec}`, "bash", "-c", body], {
              cwd: sandbox,
              encoding: "utf8",
            });
      const verdict = spawnSync(join(sandbox, "bin/loop-check-state"), ["--verdict"], {
        cwd: sandbox,
        encoding: "utf8",
      });
      return { status: run.status ?? -1, stdout: run.stdout ?? "", verdict: verdict.status ?? -1 };
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }

  it("走っている最中は、まだ終わっていないと記録されている", () => {
    // **これが本体である。** **背景に回した起動側の完了通知を「check の完了」と
    // 読んだ**（worker-1）——**走っている最中に読める記録があれば、そこで分かる。**
    const result = runCheck("./bin/loop-check-state --verdict; echo verdict=$?; return 0");

    expect(result.stdout, "走っている最中に「走っている」と読めない").toContain("verdict=3");
  });

  it("走り終えたら、合否が記録に残る", () => {
    expect(runCheck("return 0").verdict, "緑が残っていない").toBe(0);
    expect(runCheck("return 3").verdict, "赤が残っていない").toBe(1);
  });

  it("コンテナを起こせなくても、前の緑は残らない", () => {
    // **`ensure_up` が落ちる理由は、たいてい「その変更がコンテナを壊している」**
    // ——**まさにそのとき、前の緑で commit が通ってはいけない** (#376 のレビュー)。
    // **記録は `ensure_up` より前に置く。**
    const result = runCheck("return 0", undefined, {
      seed: "finished 0",
      ensureUp: "return 1",
    });

    expect(result.verdict, "前の緑が残っている").not.toBe(0);
  });

  it("記録できなければ、印を出さずに落ちる", () => {
    // **「打っていない」と「打ったが記録できなかった」は別**である
    // ——**見分けられないので、記録できない check は使えないものとして落とす。**
    // **印を出さない**のは、**印が「走り終えた」を意味するから**である。
    const result = runCheck("return 0", undefined, { breakRecorder: true });

    expect(result.status, "記録できないのに緑で返している").not.toBe(0);
    expect(result.stdout, "走り終えた顔をしている").not.toContain("check-exit");
  });

  it("殺されたら、走っているままになる", () => {
    // **`done` を書けずに終わる**ので、**記録は「走っている」のまま**である
    // ——**次の commit は、そこで止まる**（`bin/loop-commit-guard`）
    expect(runCheck("sleep 30", 1).verdict, "殺されたのに終わった顔をしている").toBe(3);
  });

  /** そのブロックが push するか。 */
  function pushes(body: string): boolean {
    return /git push/.test(body);
  }

  /**
   * ブロックを走らせ、**`git push` が呼ばれたか**と**何を記録したか**を返す。
   *
   * **`./task check` を差し替える**（合否とログの中身を作る）。
   * **`git` と `bin/loop-stall` は偽物**にして、**呼ばれたことだけ**を見る。
   */
  function runBlock(body: string, check: string): { pushed: boolean; stalled: string } {
    const workspace = mkdtempSync(join(tmpdir(), "check-push-"));
    try {
      const stub = join(workspace, "stub");
      mkdirSync(stub, { recursive: true });
      mkdirSync(join(workspace, "bin"), { recursive: true });
      writeFileSync(join(stub, "gh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
      writeFileSync(
        join(stub, "git"),
        [
          "#!/usr/bin/env bash",
          `[[ $1 == push ]] && printf 'pushed\\n' >> ${JSON.stringify(join(workspace, "pushed"))}`,
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      // **この節は `bin/loop-claim pr` も通る**（編集する前に取る。#203）——
      // **偽物を置かないと、取れずにブロックの残りが走らない。**
      writeFileSync(join(workspace, "bin", "loop-claim"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });
      // **この節は `bin/loop-sync-main` も通る**（取ってくるだけの口）。
      // **無いと、そこで止まって以降が走らない**——見たいのはその先である
      writeFileSync(join(workspace, "bin", "loop-sync-main"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });
      writeFileSync(
        join(workspace, "bin", "loop-stall"),
        [
          "#!/usr/bin/env bash",
          `printf '%s\\n' "$*" >> ${JSON.stringify(join(workspace, "stalled"))}`,
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      spawnSync("bash", ["-c", body.replace(/<[^>]+>/g, "1").replaceAll("./task check", check)], {
        cwd: workspace,
        encoding: "utf8",
        env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
      });

      const readIf = (name: string) =>
        existsSync(join(workspace, name)) ? readFileSync(join(workspace, name), "utf8") : "";
      return { pushed: readIf("pushed") !== "", stalled: readIf("stalled") };
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  it("赤のときは、push しない", () => {
    // **`status` を受けただけでは、誰も見ていない**（`tail` は必ず成功する）——
    // **赤でも印が無くても、そのまま push へ進む**。**足りないのは分岐だけ**である
    for (const block of checkBlocks().filter((b) => pushes(b.body))) {
      const result = runBlock(block.body, "bash -c 'echo check-exit=2; exit 2'");

      expect(result.pushed, `${block.section}: 赤なのに push した`).toBe(false);
    }
  });

  it("印が無いときは、push せず記録する", () => {
    // **殺されると印が出ない**（この PR の本体）。**分からないものを緑と読まない**
    for (const block of checkBlocks().filter((b) => pushes(b.body))) {
      const result = runBlock(block.body, "bash -c 'echo 走っている途中; exit 137'");

      expect(result.pushed, `${block.section}: 分からないのに push した`).toBe(false);
      expect(result.stalled, `${block.section}: 押し通した記録が残らない`).toContain(
        "local-ci-unknown",
      );
    }
  });

  it("緑のときは、push する", () => {
    // **止める側だけを見ない**（#168 で踏んだ）。**通る周回で止めては、何も進まない**
    for (const block of checkBlocks().filter((b) => pushes(b.body))) {
      const result = runBlock(block.body, "bash -c 'echo check-exit=0'");

      expect(result.pushed, `${block.section}: 緑なのに push していない`).toBe(true);
      expect(result.stalled, `${block.section}: 緑なのに記録している`).toBe("");
    }
  });

  it.each(checkBlocks().map((block, index) => [index, block.section] as const))(
    "%i 番目（%s）は、2 本同時に走ってもそれぞれ自分の出力だけを読む",
    (index) => {
      // **固定パスだと、後発が先発を truncate して出力が混ざる**（#130）。
      // **壊れるのは判定ではなく調査**である——**合否は `$status` なので正しいまま**で、
      // **読む側は log を疑わない**。**症状は「原因が分からない」ではなく
      // 「間違った原因が読める」**（他方の失敗を自分のものとして読む）。
      //
      // **「固定パスでなくなったこと」ではなく、「混ざらないこと」を見る**（master の指定）
      const workspace = mkdtempSync(join(tmpdir(), "check-log-"));
      try {
        const tmp = join(workspace, "tmp");
        mkdirSync(tmp, { recursive: true });
        // **列挙して 1 つしか走らせない**と、**残りが固定パスへ戻っても緑のまま**になる
        // （#183 のレビュー）——**「4 箇所ある」という主張を、実行が裏切る**
        const block = checkBlocks()[index]?.body ?? "";
        expect(block, "`./task check` を打つ節が無い").not.toBe("");

        /**
         * **重なるように走らせる。** すれ違うだけでは truncate を起こせない。
         * **失敗として返す**——**読む側が中身を見るのは落ちたとき**である
         */
        // **絞り込みに当たらない失敗を作る**（#183 のレビュー）。**`Error:` も
        // `ELIFECYCLE` も大文字**で、**`grep -aE "error|×"` は 1 行も出さない**——
        // **絞り込みに賭けると、外れた瞬間に唯一の写しが消える**
        const fake = (mark: string) =>
          `bash -c 'echo "ELIFECYCLE ${mark}"; sleep 0.4; echo "ELIFECYCLE ${mark}"; echo check-exit=1; exit 1'`;
        const body = (mark: string) =>
          block.replace(/<[^>]+>/g, "1").replaceAll("./task check", fake(mark));

        writeFileSync(
          join(workspace, "run.sh"),
          [
            "#!/usr/bin/env bash",
            "(",
            body("AAAA"),
            `) > "${join(workspace, "outA")}" 2>&1 &`,
            "(",
            body("BBBB"),
            `) > "${join(workspace, "outB")}" 2>&1 &`,
            "wait",
            "",
          ].join("\n"),
          { mode: 0o755 },
        );
        // **`bin/` の偽物**（この節は落ちたときに記録を通す）
        mkdirSync(join(workspace, "bin"), { recursive: true });
        for (const name of ["loop-stall", "loop-sync-main", "loop-claim"]) {
          writeFileSync(join(workspace, "bin", name), "#!/usr/bin/env bash\nexit 0\n", {
            mode: 0o755,
          });
        }
        for (const name of ["git", "gh"]) {
          writeFileSync(join(workspace, name), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
        }

        spawnSync("bash", [join(workspace, "run.sh")], {
          cwd: workspace,
          encoding: "utf8",
          env: { ...process.env, TMPDIR: tmp, PATH: `${workspace}:${process.env.PATH}` },
        });

        const outA = readFileSync(join(workspace, "outA"), "utf8");
        const outB = readFileSync(join(workspace, "outB"), "utf8");

        expect(outA, "自分の出力を読めていない").toContain("AAAA");
        expect(outA, "他方の出力が混ざっている").not.toContain("BBBB");
        expect(outB, "自分の出力を読めていない").toContain("BBBB");
        expect(outB, "他方の出力が混ざっている").not.toContain("AAAA");
        // **走り終わったら残らない**（残すと溜まる）
        expect(readdirSync(tmp), "出力ファイルが残っている").toEqual([]);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    },
  );

  it("`./task check` を打つ節を、全部並べて突き合わせる", () => {
    // **絞ってから見ない。** **打つのに見ていない節**が 1 つでもあれば、
    // そこから「殺されたのに緑」が入る——**レビューの往復ごとに通る経路**もある
    expect(
      checkBlocks().map((block) => [block.section, block.body.includes("check-exit")]),
    ).toEqual([
      ["### 保留を解いた PR を rebase する", true],
      ["### 保留を解いた PR を rebase する", true],
      ["### 実装は必ずテストファースト", true],
      ["### PR を作る", true],
    ]);
    // **push があるブロックは、分岐してから push する。** **「印を含むか」しか
    // 見ていないと、含んでいるが使っていないが通る**（master の指摘）——
    // **定義の外ではなく、定義の中で何を見るか**である
    expect(checkBlocks().map((block) => [block.section, pushes(block.body)])).toEqual([
      ["### 保留を解いた PR を rebase する", true],
      ["### 保留を解いた PR を rebase する", true],
      ["### 実装は必ずテストファースト", false],
      ["### PR を作る", true],
    ]);
  });

  it("手順書が、印と終了コードの両方を見る", () => {
    // **片方だけだと、片方の壊れ方をそのまま通す**（#147 の本文）。
    // **`status` が空でないこと**と**ログの末尾に印があること**の両方である。
    //
    // **散文ではなく、打つところで見る。** 節全体で見ると**表や説明に
    // `check-exit` があるだけで満たされ**、**ブロックから消しても緑のまま**になる
    // （#168 のレビュー 2 周目で踏んだ形——**書いたのに入っていない**）
    for (const block of checkBlocks()) {
      expect(block.body, `${block.section}: 終了コードを見ていない`).toContain("status=$?");
      expect(block.body, `${block.section}: 終わりの印を見ていない`).toContain("check-exit");
    }
  });

  it("「分からない」を「赤」と混ぜない", () => {
    // **どちらも push を止める必要は無いが、記録が違う**（#147 の完了条件）。
    // **押し通してよいが、押し通したと記録に残る**
    const section =
      procedureText("worker").split("### 実装は必ずテストファースト")[1]?.split("\n### ")[0] ?? "";
    const listed = spawnSync(join(REPO_ROOT, "bin/loop-stall"), ["--list"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).stdout;

    expect(section, "分からないときの記録が無い").toContain(
      'bin/loop-stall "local-ci-unknown:<Issue番号>"',
    );
    expect(listed, "識別子が一覧に無い").toContain("local-ci-unknown:<Issue番号>");
    expect(listed, "赤と同じ名前になっている").toContain("local-ci-failed:<PR番号>");
  });
});
