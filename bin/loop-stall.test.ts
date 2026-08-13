import { execFileSync, type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { holdingSnippet } from "../test/held-lock";
import { MODELLED_SPAWNS, SCRIPT_TEST_TIMEOUT_MS } from "../test/slow-machine";

const SCRIPT = fileURLToPath(new URL("./loop-stall", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

type Run = { status: number; stdout: string; stderr: string };

/** 実カウンタを壊さないよう、使い捨ての git リポジトリを cwd にして呼ぶ。 */
function run(args: string[], cwd = REPO_ROOT): Run {
  const result = spawnSync(SCRIPT, args, {
    cwd,
    encoding: "utf8",
    // 上限に達すると全ループを止めてしまうため、テストでは到達させない。
    env: { ...process.env, LOOP_MAX_STALL_REPEATS: "99" },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** `--list` が出す識別子の書式（説明は落とす）。 */
function listedSpecs(): string[] {
  const listed = run(["--list"]);
  expect(listed.status).toBe(0);
  return listed.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.trim().split(/\s+/)[0] ?? "");
}

describe("bin/loop-stall の停止識別子", () => {
  let sandbox: string;

  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), "loop-stall-"));
    const init = spawnSync("git", ["init", "--quiet", sandbox], { encoding: "utf8" });
    expect(init.status).toBe(0);
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("--list は識別子の書式と説明を一覧で出す", () => {
    const listed = run(["--list"]);

    expect(listed.status).toBe(0);
    expect(listed.stdout).toMatch(/^dirty\s+\S/m);
    expect(listedSpecs()).toContain("too-many-own-prs:<件数>");
  });

  it("同じ種別の識別子が一覧に 2 つ以上ない", () => {
    const kinds = listedSpecs().map((spec) => spec.split(":")[0]);

    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("一覧にある書式に合う識別子は受け付ける", () => {
    const accepted = run(["wrong-branch:12"], sandbox);

    expect(accepted.status).toBe(0);
    expect(accepted.stdout).toContain("count=1");
  });

  it("表記のゆれた識別子は弾き、使える識別子を示す", () => {
    // 実際に食い違っていた綴り。黙って数え直されると 3 周続いても止まらない。
    const rejected = run(["too-many-prs:2"], sandbox);

    expect(rejected.status).toBe(2);
    expect(rejected.stderr).toContain("too-many-own-prs:<件数>");
  });

  it("種別が正しくても引数の形が違えば弾く", () => {
    expect(run(["wrong-branch"], sandbox).status).toBe(2);
    expect(run(["wrong-branch:main"], sandbox).status).toBe(2);
    expect(run(["merge-failed:12"], sandbox).status).toBe(2);
  });

  it("git が受け付けるブランチ名は、そのまま記録できる", () => {
    // **同じファイルの中で、2 つの検査が違う幅を見ていた**（#148 のレビュー 2 周目）。
    // **内側（書式）を広げても、外側の文字検査が先に立つ**ので届かない。
    //
    // **倒れる向きが目的と逆だった**——**`no-pr` は見つかるのに記録できない**ので、
    // **人へ渡らない**。しかも **`exit 2` は「記録できていない」**なので、
    // **3 周の経路にも乗らない**——**「誰も見ていない」が、そのブランチにだけ残る**
    for (const branch of ["feat/a+b", "release/a=b", "feat/a{b}"]) {
      expect(
        spawnSync("git", ["check-ref-format", "--branch", branch]).status,
        `${branch} は git が受け付けない`,
      ).toBe(0);

      const recorded = run([`stray-branch:${branch}`], sandbox);

      expect(recorded.status, `${branch} を記録できない`).toBe(0);
      run(["--reset"], sandbox);
    }
  });

  it("制御文字が混ざるものは、これまでどおり弾く", () => {
    // **外側の検査の目的は落とさない**（識別子は**タブ区切りの行**に書かれるので、
    // 制御文字が混ざると**記録の列が壊れる**）。**git もこれらを受け付けない**。
    //
    // **空白では外側を押さえられない。** 内側の書式（`<ブランチ>` は `[^[:space:]]+`）でも
    // 弾かれるので、**外側を `.+` へ広げても緑のまま**になる——**その条件を満たしたまま
    // 壊せる形**が、まさにこれだった（**制御文字は内側を通る**）
    for (const bad of ["stray-branch:feat/a\u0001b", "stray-branch:feat/a\u007fb"]) {
      expect(run([bad], sandbox).status, `${JSON.stringify(bad)} を受け付けている`).toBe(2);
    }
    // 空白と改行も、これまでどおり弾く（こちらは内側と外側の両方が見る）
    for (const bad of ["stray-branch:feat/a b", "stray-branch:feat/a\nb"]) {
      expect(run([bad], sandbox).status, `${JSON.stringify(bad)} を受け付けている`).toBe(2);
    }
  });

  it("--reset は識別子の検査を通さずカウンタを消す", () => {
    const reset = run(["--reset"], sandbox);

    expect(reset.status).toBe(0);
    expect(run(["wrong-branch:12"], sandbox).stdout).toContain("count=1");
  });
});

describe("上限に達したときに止める対象", () => {
  /**
   * スクリプトのコピーと**本物の `task`** を使い、使い捨てのリポジトリで上限まで走らせる。
   * **本物の bin/loop-stall をそのまま上限まで走らせない。** それをやると実際に
   * 実リポジトリの両 worktree が停止する（この Issue の事故そのもの）。
   *
   * **実リポジトリは見ない**（#186 のレビュー）。`loop/STOP` は**人ともう一方のループが
   * 正当に作り消しするファイル**なので、**そこを観測すると、副作用の主体を判別できない**
   * ——**`./task loop:resume` が試験の最中に走っただけで落ちる**（`existsSync` と
   * `statSync` の間なら `ENOENT` で落ちる）。**合否が他人の持ち物で決まる**という、
   * **#184 が消しに来た形そのもの**である。**`scriptRepo` を身代わりにする。**
   *
   * **測るものは 2 つある。**
   *
   * - **そのリポジトリのコードが動いたか**（`ran`）——`-x` は「Valence のタスクランナー
   *   である」ことを保証しないので、**動くこと自体が事故**である
   * - **そのリポジトリが止まったか**（`loop/STOP`）——**`task` を通らずに止める**形は
   *   `ran` では捕まらない。**仕組みではなく結果を見る**
   *
   * **印だけの偽物にしない。** 「呼ばれた」しか分からないと**配る側が壊れても気づけない**
   * （`describe("作業が尽きた周回の数え方")` と同じ理由・同じ作り）。
   * **本物へ渡す前に印を残すだけ**にして、**振る舞いは写さない。**
   */
  function runToLimit(options: { cwd: "same-repo" | "other-repo" }): {
    status: number;
    stderr: string;
    ranScriptRepoTask: boolean;
    ranCwdRepoTask: boolean;
    stoppedScriptRepo: boolean;
    stoppedCwdRepo: boolean;
  } {
    const scriptRepo = mkdtempSync(join(tmpdir(), "loop-stall-script-"));
    const otherRepo = mkdtempSync(join(tmpdir(), "loop-stall-cwd-"));
    for (const repo of [scriptRepo, otherRepo]) {
      spawnSync("git", ["init", "--quiet", repo]);
      // **呼ばれてはいけない側にも置く**ので、動いたかどうかがそのまま判定になる
      copyFileSync(join(REPO_ROOT, "task"), join(repo, "real-task"));
      chmodSync(join(repo, "real-task"), 0o755);
      writeFileSync(
        join(repo, "task"),
        `#!/usr/bin/env bash\ntouch '${repo}/ran'\nexec '${repo}/real-task' "$@"\n`,
        { mode: 0o755 },
      );
    }
    mkdirSync(join(scriptRepo, "bin"));
    const script = join(scriptRepo, "bin", "loop-stall");
    copyFileSync(SCRIPT, script);
    chmodSync(script, 0o755);

    const cwd = options.cwd === "same-repo" ? scriptRepo : otherRepo;
    let result = spawnSync(script, ["dirty"], { cwd, encoding: "utf8" });
    for (let i = 0; i < 2; i++) {
      result = spawnSync(script, ["dirty"], { cwd, encoding: "utf8" });
    }
    const ran = {
      status: result.status ?? -1,
      stderr: result.stderr,
      ranScriptRepoTask: existsSync(join(scriptRepo, "ran")),
      ranCwdRepoTask: existsSync(join(otherRepo, "ran")),
      stoppedScriptRepo: existsSync(join(scriptRepo, "loop", "STOP")),
      stoppedCwdRepo: existsSync(join(otherRepo, "loop", "STOP")),
    };
    rmSync(scriptRepo, { recursive: true, force: true });
    rmSync(otherRepo, { recursive: true, force: true });
    return ran;
  }

  it("cwd が別のリポジトリなら、どちらの task も実行しない", () => {
    // -x は「Valence のタスクランナーである」ことを保証しない。実行してしまうと
    // **そのリポジトリが用意した任意のコードが動く**
    const result = runToLimit({ cwd: "other-repo" });

    expect(result.ranCwdRepoTask).toBe(false);
    expect(result.ranScriptRepoTask).toBe(false);
  });

  it("cwd が別のリポジトリなら、どちらのリポジトリも止まらない", () => {
    // **仕組みではなく結果を見る**（#186 のレビュー）。**`task` を通らずに止める**形は
    // 上の「実行しない」では捕まらない——**止まったかどうかは `loop/STOP` にしか出ない**。
    //
    // **身代わりは `scriptRepo` である。** 事故の形は
    // **「cwd が別なのに、スクリプトが自分の住んでいるリポジトリを止める」**なので、
    // **その役をここで演じさせる**——**実リポジトリを観測しなくても、同じ主張が押さえられる**
    const result = runToLimit({ cwd: "other-repo" });

    expect(result.stoppedScriptRepo, "スクリプトの住むリポジトリが止まっている").toBe(false);
    expect(result.stoppedCwdRepo, "cwd のリポジトリが止まっている").toBe(false);
  });

  it("cwd が別のリポジトリなら、止めなかった理由を出す", () => {
    // 黙って何もしないのは、黙って止めるのと同じくらい分かりにくい
    const result = runToLimit({ cwd: "other-repo" });

    // **1 つも止めていない**ので、**「全ループが停止済み」と同じ値にしない** (#191)
    expect(result.status, "止めていないのに「停止済み」と同じ値を返している").not.toBe(1);
    expect(result.stderr).toContain("止められません");
  });

  it("シンボリックリンク経由で cd しても同じリポジトリと判定する", () => {
    // bash の cd / pwd は既定でリンクを保った論理パスを返す。到達経路が違うだけで
    // 別リポジトリ扱いになると、**止まっていないのに exit 1（停止済み）を返す**
    const scriptRepo = mkdtempSync(join(tmpdir(), "loop-stall-script-"));
    spawnSync("git", ["init", "--quiet", scriptRepo]);
    writeFileSync(join(scriptRepo, "task"), `#!/usr/bin/env bash\ntouch '${scriptRepo}/ran'\n`, {
      mode: 0o755,
    });
    mkdirSync(join(scriptRepo, "bin"));
    const script = join(scriptRepo, "bin", "loop-stall");
    copyFileSync(SCRIPT, script);
    chmodSync(script, 0o755);
    const link = `${scriptRepo}-link`;
    symlinkSync(scriptRepo, link);

    // Node の cwd 指定では物理パスに解決されてしまうので、シェルの cd を通す
    let result: ReturnType<typeof spawnSync>;
    for (let i = 0; i < 3; i++) {
      result = spawnSync("/usr/bin/bash", ["-c", `cd '${link}' && '${script}' dirty`], {
        encoding: "utf8",
      });
    }
    const ran = existsSync(join(scriptRepo, "ran"));
    // biome-ignore lint/style/noNonNullAssertion: ループで必ず代入される
    const stderr = result!.stderr as unknown as string;
    rmSync(link, { force: true });
    rmSync(scriptRepo, { recursive: true, force: true });

    expect(stderr).not.toContain("止められません");
    expect(ran).toBe(true);
  });

  it("リンクされた worktree から実行しても同じリポジトリと判定する", () => {
    // rev-parse --git-common-dir は **リンクされた worktree では絶対パス**、
    // 通常のリポジトリでは相対パス（../.git）を返す。両方を通さないと、
    // master 側（worktree）だけ第 4 層が効かなくなる
    const repo = mkdtempSync(join(tmpdir(), "loop-stall-repo-"));
    spawnSync("git", ["init", "--quiet", repo]);
    writeFileSync(join(repo, "task"), '#!/usr/bin/env bash\ntouch "$(pwd)/ran"\n', {
      mode: 0o755,
    });
    mkdirSync(join(repo, "bin"));
    const script = join(repo, "bin", "loop-stall");
    copyFileSync(SCRIPT, script);
    chmodSync(script, 0o755);
    // worktree を足すには commit が要る
    spawnSync("git", ["-C", repo, "add", "-A"]);
    spawnSync("git", [
      "-C",
      repo,
      "-c",
      "user.email=loop@example.invalid",
      "-c",
      "user.name=loop",
      "commit",
      "--quiet",
      "-m",
      "init",
    ]);
    const worktree = `${repo}-wt`;
    spawnSync("git", ["-C", repo, "worktree", "add", "--detach", "--quiet", worktree]);

    // **worktree 側のスクリプトを、その worktree から呼ぶ。** master はこの形で走る。
    // リンクされた worktree 内では rev-parse が絶対パスを返すので、
    // script_dir との連結が失敗する経路に入る
    const scriptInWorktree = join(worktree, "bin", "loop-stall");
    let result = spawnSync(scriptInWorktree, ["dirty"], { cwd: worktree, encoding: "utf8" });
    for (let i = 0; i < 2; i++) {
      result = spawnSync(scriptInWorktree, ["dirty"], { cwd: worktree, encoding: "utf8" });
    }
    const ran = existsSync(join(worktree, "ran"));
    const stderr = result.stderr;
    spawnSync("git", ["-C", repo, "worktree", "remove", "--force", worktree]);
    rmSync(worktree, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });

    expect(stderr).not.toContain("止められません");
    expect(ran).toBe(true);
  });

  it("cwd がスクリプトと同じリポジトリなら止める", () => {
    // **「呼んだ」ではなく「止まった」まで見る**（#186 のレビュー）。**呼ぶところまでしか
    // 見ないと、配る側が壊れても気づけない**——**止める側の試験なので、止まることを見る**
    const result = runToLimit({ cwd: "same-repo" });

    expect(result.status).toBe(1);
    expect(result.ranScriptRepoTask).toBe(true);
    expect(result.stoppedScriptRepo, "止めると言いながら止まっていない").toBe(true);
  });
});

describe("作業が尽きた周回の数え方", () => {
  /**
   * 本物の `task` を持つ使い捨てリポジトリに worktree を足し、上限まで走らせる。
   * **`loop/STOP` が両方の worktree へ配られるところまで**を見る。偽の `task` だと
   * 「呼ばれた」しか分からず、**配る側が壊れても気づけない**。
   */
  /** steps とは無関係に必ず起こす git の回数（init / add / commit / worktree add・remove）。 */
  const FIXED_SPAWNS = 5;

  function runNoWorkToLimit(steps: string[]): { status: number; stops: boolean[] } {
    // **起こしたプロセスを数える。** 枠（test/slow-machine.ts）はこの回数から
    // 導いてあるので、**手で書いた回数と実際がずれると枠が足りなくなる**。
    // 実際に 1 つずれていた（固定 5 回に steps 最大 5 件で 10 回なのを 9 と数えていた）。
    // **数えている側で確かめる**——見積もりを 2 箇所に書くと、片方だけ直して食い違う。
    let spawns = 0;
    function counted(command: string, args: string[], cwd?: string): SpawnSyncReturns<string> {
      spawns += 1;
      return spawnSync(command, args, { cwd, encoding: "utf8" });
    }

    const repo = mkdtempSync(join(tmpdir(), "loop-stall-nowork-"));
    counted("git", ["init", "--quiet", repo]);
    copyFileSync(join(REPO_ROOT, "task"), join(repo, "task"));
    chmodSync(join(repo, "task"), 0o755);
    mkdirSync(join(repo, "bin"));
    const script = join(repo, "bin", "loop-stall");
    copyFileSync(SCRIPT, script);
    chmodSync(script, 0o755);
    counted("git", ["-C", repo, "add", "-A"]);
    counted("git", [
      "-C",
      repo,
      "-c",
      "user.email=loop@example.invalid",
      "-c",
      "user.name=loop",
      "commit",
      "--quiet",
      "-m",
      "init",
    ]);
    const worktree = `${repo}-wt`;
    counted("git", ["-C", repo, "worktree", "add", "--detach", "--quiet", worktree]);

    let result = counted(script, [steps[0] ?? "no-work"], repo);
    for (const step of steps.slice(1)) {
      result = counted(script, [step], repo);
    }
    const stops = [
      existsSync(join(repo, "loop", "STOP")),
      existsSync(join(worktree, "loop", "STOP")),
    ];
    counted("git", ["-C", repo, "worktree", "remove", "--force", worktree]);
    rmSync(worktree, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });

    // **数え落としも検出する。** 上限だけを見ると、**数える側が壊れたときに
    // 黙って通る**（0 回はいつでも上限の内側にある）。固定の 5 回と steps の件数から
    // 出した値と**一致すること**まで見る
    expect(spawns, "起こしたプロセスの数が見積もりと違う").toBe(FIXED_SPAWNS + steps.length);
    expect(spawns, "枠の見積もりより多くプロセスを起こしている").toBeLessThanOrEqual(
      MODELLED_SPAWNS,
    );
    return { status: result.status ?? -1, stops };
  }

  it("3 周続くと loop/STOP が両方の worktree へ配られる", () => {
    // 作業が尽きた状態はループの中では解けない。**記録されないと永久に空回りする**
    const result = runNoWorkToLimit(["no-work", "no-work", "no-work"]);

    expect(result.status).toBe(1);
    expect(result.stops).toEqual([true, true]);
  });

  it("2 周では止まらない", () => {
    // すぐ Issue を足すつもりで席を外しているだけなら、その間に止めない
    const result = runNoWorkToLimit(["no-work", "no-work"]);

    expect(result.status).toBe(0);
    expect(result.stops).toEqual([false, false]);
  });

  it("master の要求が外れないまま 3 周続くと loop/STOP が配られる", () => {
    // **label は master しか外せない。** 外し忘れると、その PR は永久にマージされず
    // 3 周続いても人を呼べない（#47 で塞いだ形が別の場所に開く）
    const sha = "a".repeat(40);
    const id = `awaiting-worker:50@${sha}`;
    const result = runNoWorkToLimit([id, id, id]);

    expect(result.status).toBe(1);
    expect(result.stops).toEqual([true, true]);
  });

  it("worker が push した周回は数え直す（SHA が変わる）", () => {
    // 対応が進んでいるあいだに止めない
    const a = `awaiting-worker:50@${"a".repeat(40)}`;
    const b = `awaiting-worker:50@${"b".repeat(40)}`;
    const result = runNoWorkToLimit([a, a, b]);

    expect(result.status).toBe(0);
    expect(result.stops).toEqual([false, false]);
  });

  it("もう一方のループの停止が挟まっても数え直さない", () => {
    // **カウンタは master と worker で共有している。** 別の識別子で数え直す作りだと、
    // 「master は no-work、worker は dirty」で交互に書き合って **どちらも 3 に届かない**。
    // 止めるための仕組みが、2 つ動いているというだけで無効になる
    const result = runNoWorkToLimit(["no-work", "dirty", "no-work", "dirty", "no-work"]);

    expect(result.status).toBe(1);
    expect(result.stops).toEqual([true, true]);
  });

  it("前へ進んだ周回を挟むと、他の識別子の記録も消える", () => {
    // --reset は「前へ進んだ」の合図。**識別子ごとに残すと、進んだ後の 1 回で
    // 昔の記録が上限に達する**
    const result = runNoWorkToLimit(["no-work", "dirty", "--reset", "no-work", "dirty"]);

    expect(result.status).toBe(0);
    expect(result.stops).toEqual([false, false]);
  });

  it("前へ進んだ周回を挟むと数え直す", () => {
    // 起票や PR で状態が動いたら --reset が呼ばれる。**間隔を空けた 3 回で止めない**
    const result = runNoWorkToLimit(["no-work", "no-work", "--reset", "no-work", "no-work"]);

    expect(result.status).toBe(0);
    expect(result.stops).toEqual([false, false]);
  });
});

describe("共有カウンタの排他", () => {
  /** スクリプトのコピーだけを置いた使い捨てリポジトリ。 */
  function makeRepo(): { repo: string; script: string; state: string } {
    const repo = mkdtempSync(join(tmpdir(), "loop-stall-lock-"));
    spawnSync("git", ["init", "--quiet", repo]);
    writeFileSync(join(repo, "task"), "#!/usr/bin/env bash\ntrue\n", { mode: 0o755 });
    mkdirSync(join(repo, "bin"));
    const script = join(repo, "bin", "loop-stall");
    copyFileSync(SCRIPT, script);
    chmodSync(script, 0o755);
    return { repo, script, state: join(repo, ".git", "valence-loop-stall") };
  }

  /**
   * ロックを握らせたまま本体を走らせる bash。**時間はどこにも要らない。**
   *
   * **保持側は自分のプロセスグループで起こし、標準出力を切り離す。**
   *   - **切り離す理由**: 継承したままだと、外側の bash が殺されても
   *     **`spawnSync` がパイプの終わりを待ち続ける**（返ってこない）
   *   - **グループにする理由**: `timeout` が届くのは**直下の bash だけ**なので、
   *     **背後の保持側が生き残る**。グループごと終えられる形にしておく
   *   - **`trap` を張る理由**: 上限で殺されたときにも後始末を通すため。
   *     **`EXIT` だけでは、シグナルで死んだときに走らない**
   *
   * **`setsid` と `trap` のどちらか一方では足りない。** 前者だけだと後始末を
   * 呼ぶ者がおらず、後者だけだと**送る先が直下の 1 つ**になる。
   */
  function holdingScript(paths: { repo: string; script: string; state: string }): string {
    const { repo, script, state } = paths;
    return `mkfifo '${repo}/held' '${repo}/release'
      ${holdingSnippet({ lock: `${state}.lock`, held: `${repo}/held`, release: `${repo}/release` })}
      holder=$!
      trap 'kill -TERM -"$holder" 2>/dev/null; exit 1' EXIT TERM INT
      read -r _ < '${repo}/held'
      '${script}' no-work
      echo "stall_exit=$?"
      echo x > '${repo}/release'
      wait "$holder" 2>/dev/null`;
  }

  it("ロックが取られている間は待ち、解放されてから数える", () => {
    // **カウンタは master と worker が同じ周期で書きうる。** 読んでから書くまでを
    // 排他しないと、後から書いた側が相手の増分を消す（記録が増えないまま周回が進み、
    // **どちらの識別子も上限に届かない**）。
    const { repo, script, state } = makeRepo();
    // 先に 1 回書いて、ロック対象のファイルを作っておく
    spawnSync(script, ["no-work"], { cwd: repo, encoding: "utf8" });
    // 外から 1 秒ロックを保持し、**待たされた時間**を見る。
    // 「結果が正しい」だけでは、ロックを取らない実装でも通ってしまう
    // **握ったことを事象で待つ。** `sleep` で待つと、**負荷が高い日に「まだ握って
    // いない」まま本体が走る**（#141）。**保持している長さはここでの測定対象**なので
    // 残すが、**待つのは時間ではなく「握った」という知らせ**である
    const holder = spawnSync(
      "/usr/bin/bash",
      [
        "-c",
        // **保持の長さそのものが測定対象**なので `sleep 1` で握る。上限は要らない
        // （`sleep` が上限そのものである）。**知らせだけは開いたまま持つ**——
        // `echo x > FIFO` は**読み手が現れるまで open で止まる**ので、
        // **親が先に死ぬとそこで永久に残る**
        `mkfifo '${repo}/held'
         setsid flock '${state}.lock' /usr/bin/bash -c 'exec 3<>"${repo}/held"; echo x >&3; sleep 1' \
           </dev/null >/dev/null 2>&1 &
         holder=$!
         trap 'kill -TERM -"$holder" 2>/dev/null; exit 1' EXIT TERM INT
         read -r _ < '${repo}/held'
         start=$(date +%s%N)
         '${script}' no-work
         end=$(date +%s%N)
         echo "elapsed_ms=$(( (end - start) / 1000000 ))"
         wait`,
      ],
      {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, LOOP_MAX_STALL_REPEATS: "99" },
        // **知らせ合いが噛み合わないと、どちらも相手を待って固まる。**
        // `spawnSync` は vitest の枠では中断できないので、**外側に上限を置く**——
        // **判定には使わない**（合否は下の表明が決める）。固まったら落ちる
        timeout: SCRIPT_TEST_TIMEOUT_MS,
      },
    );
    const elapsed = Number(/elapsed_ms=(\d+)/.exec(holder.stdout)?.[1] ?? "0");
    const counted = readFileSync(state, "utf8");
    rmSync(repo, { recursive: true, force: true });

    expect(holder.stdout).toContain("count=2");
    // ロックを取らない実装なら数十 ms で終わる
    expect(elapsed).toBeGreaterThan(500);
    expect(counted).toContain("2\tno-work");
  });

  it("待っても取れなければ、数えずに失敗する", () => {
    // **取れないまま数えると、記録が飛んだことに誰も気づけない。**
    const { repo, script, state } = makeRepo();
    spawnSync(script, ["no-work"], { cwd: repo, encoding: "utf8" });
    // **保持の長さを仮定しない。** 以前は `sleep 2` で保持していたが、
    // **負荷が高いと本体の起動と待ちの合計が 2 秒を超え、先に放してしまう**——
    // すると本体はロックを取れてしまい、`count=2` になる（#141 の実際の壊れ方）。
    // **握ったことを知らせ合い、本体が終わってから放す**——時間はどこにも要らない
    const result = spawnSync("/usr/bin/bash", ["-c", holdingScript({ repo, script, state })], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, LOOP_STALL_LOCK_WAIT_SEC: "1" },
      // **知らせ合いが噛み合わなければ固まらずに落ちる**（下の試験で確かめている）
      timeout: SCRIPT_TEST_TIMEOUT_MS,
    });
    const counted = readFileSync(state, "utf8");
    rmSync(repo, { recursive: true, force: true });

    // ラッパーではなく **loop-stall 自身の終了コード**を見る
    expect(result.stdout).toContain("stall_exit=2");
    expect(result.stderr).toContain("ロック");
    // 数えていないこと（1 のまま）
    expect(counted).toContain("1\tno-work");
  });
});

describe("握り合わせが噛み合わなかったとき", () => {
  // **安全網そのものを試す。** 前の版は「上限を置いた」と書いてあるだけで、
  // **上限が届くのは直下の bash だけ**だった——**背後の保持側は標準出力を継承したまま
  // 生き残る**ので、**`spawnSync` はパイプの終わりを待ち続ける**。
  //
  // **「今回は落ちた」を根拠にしない。** 変異で赤が出たことは**そのとき返っただけ**で、
  // **必ず返る保証**ではない。**保持側が残っていないことを直接見る。**

  /**
   * この試験のラッパーを打ち切る枠。**ここだけ短く切る**——見たいのは
   * 「打ち切られたときに後始末が働くか」なので、待つ理由が無い。
   */
  const ORPHAN_CUTOFF_MS = 10_000;

  /**
   * この試験の保持側だけが持つ上限。**わざと枠より長い。**
   *
   * **既定（`HOLD_LIMIT_SEC`）は「包む枠より短い」が約束である。** ここだけ逆にするのは、
   * **この試験の主題が後始末そのもの**だからである——**保持側が自分で消えてしまうと、
   * `trap` が壊れていてもロックが空き、表明が通る**（空振りする）。
   *
   * **他の保持側にこの形を持ち込まない。** 枠より長い上限は、**打ち切られたあとに
   * その差だけ残る**ことを意味する。ここは**残っていないことを直後に確かめている**ので
   * 成り立つ。
   */
  const ORPHAN_HOLD_SEC = (ORPHAN_CUTOFF_MS / 1_000) * 2;

  it("上限で打ち切られても、保持側を残さない", () => {
    // **枠の関係が崩れたら、この試験は空振りする。** 先に確かめる
    expect(ORPHAN_CUTOFF_MS, "保持側が自分で消えるので、後始末を試せていない").toBeLessThan(
      ORPHAN_HOLD_SEC * 1_000,
    );
    const repo = mkdtempSync(join(tmpdir(), "loop-stall-orphan-"));
    spawnSync("git", ["init", "--quiet", repo]);
    const lock = join(repo, "held.lock");
    writeFileSync(lock, "");

    // **握らせてから、噛み合わない状態にする。**
    //
    // **「握った」を先に確かめないと、確認そのものが空振りする**——保持側が
    // **1 度も走らなかった**場合（起動に失敗した／上限までにスケジュールされなかった）、
    // **ロックはそもそも取られていない**ので、下の `flock -n` は**当然成功**する。
    // **後始末が 1 度も走っていないのに、表明は 2 つとも通る。**
    //
    // **握れなかったら、そこで落ちる**（`read` が失敗する）。**「保持していなかった」を
    // 緑にしない**——それが**この試験が見たかったものの逆**である。
    const stuck = spawnSync(
      "/usr/bin/bash",
      [
        "-c",
        `mkfifo '${repo}/held' '${repo}/never'
         ${holdingSnippet({ lock, held: `${repo}/held`, release: `${repo}/never`, limitSeconds: ORPHAN_HOLD_SEC })}
         holder=$!
         trap 'kill -TERM -"$holder" 2>/dev/null; exit 1' EXIT TERM INT
         read -r _ < '${repo}/held' || exit 3
         echo "holder_has_lock"
         read -r _ < '${repo}/never'`,
      ],
      // **起動待ちと停止待ちで分け合っている。** 起動が遅い日にここが尽きても、
      // 下の「握った」の表明が落ちるので**空振りは緑にならない**。
      // 起動は実測で 1 秒未満なので、10 秒あれば停止待ちに十分残る
      { cwd: repo, encoding: "utf8", timeout: ORPHAN_CUTOFF_MS },
    );

    // **ロックが空いていれば、保持側は残っていない。** 「返ってきた」だけでは、
    // 背後に居座っているかどうかが分からない
    const free = spawnSync("/usr/bin/flock", ["-n", lock, "-c", "true"], { encoding: "utf8" });
    rmSync(repo, { recursive: true, force: true });

    // **まず「握っていた」ことを確かめる。** ここが通らない限り、下の 2 つには意味が無い
    expect(stuck.stdout, "保持側がロックを握っていない（確認が空振りしている）").toContain(
      "holder_has_lock",
    );
    expect(stuck.status, "上限で打ち切られていない").not.toBe(0);
    expect(free.status, "ロックが解放されていない（保持側が残っている）").toBe(0);
  });
});

describe("ドキュメントに書かれた停止識別子", () => {
  /**
   * 追跡下の Markdown から `bin/loop-stall <引数>` の呼び出しを拾う。
   * 引数が ASCII で始まるものだけを見る（「bin/loop-stall を通す」のような地の文を除く）。
   */
  function documentedArgs(): { file: string; arg: string }[] {
    const files = execFileSync("git", ["ls-files", "*.md"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter((path) => path !== "");

    const pattern = /bin\/loop-stall[ \t]+("[^"\n]*"|[-<A-Za-z0-9][^\s`"]*)/g;
    return files.flatMap((file) => {
      const body = readFileSync(join(REPO_ROOT, file), "utf8");
      return [...body.matchAll(pattern)].map((match) => ({
        file,
        arg: (match[1] ?? "").replace(/^"|"$/g, ""),
      }));
    });
  }

  it("ドキュメントに出てくる識別子はすべて一覧に載っている", () => {
    const known = new Set([...listedSpecs(), "--reset", "--list"]);

    const unknown = documentedArgs().filter(({ arg }) => !known.has(arg));

    expect(unknown).toEqual([]);
  });

  it("識別子を使う判定箇所が実際に存在する", () => {
    const args = documentedArgs().map(({ arg }) => arg);

    expect(args.filter((arg) => !arg.startsWith("--")).length).toBeGreaterThan(0);
  });

  it("作業が尽きた周回を数えるのは master の手順だけ", () => {
    // **両側で数えると 2 倍の速さで 3 周に達する。** worker は master が起票する前の
    // 周回でも「ready なし」で終わるので、そこで数えると実際には 1.5 周ぶんで止まる
    const users = documentedArgs()
      .filter(({ arg }) => arg === "no-work")
      .map(({ file }) => file);

    expect(users).toContain(".claude/commands/loop-master.md");
    expect(users).not.toContain(".claude/commands/loop-worker.md");
  });
});

describe("worker が作業しているあいだは数えない", () => {
  // **第 4 層は master の周回で数えるが、前へ進めるのは worker の周回**である。
  // master は 7〜10 分ごと、worker の 1 周は 40〜60 分。**同じ状態を 3 回見るのに
  // 21〜30 分しかかからない**ので、**指摘の修正に master 3 周ぶんかかる作業は
  // 必ず止められる**（実測で 5 回）。**難しい指摘ほど踏む**——#126 と同じ逆相関である。
  //
  // **心拍は「前へ進んだ」ではない**ので、生きているだけでは永久に猶予しない。
  // **数える単位を worker の周回に変える**——worker が 1 周を始めるたびに 1 回だけ数え、
  // **worker が黙ったら（活動が期限切れ）これまでどおり master の周回で数える**。

  let repo: string;

  function setup(): void {
    repo = mkdtempSync(join(tmpdir(), "loop-stall-rounds-"));
    expect(spawnSync("git", ["init", "--quiet", repo]).status).toBe(0);
    mkdirSync(join(repo, "bin"));
    for (const name of ["loop-stall", "loop-lease"]) {
      copyFileSync(join(REPO_ROOT, "bin", name), join(repo, "bin", name));
      chmodSync(join(repo, "bin", name), 0o755);
    }
    // 呼ばれたことだけを残す task（本物のように loop/STOP は配らない）
    writeFileSync(join(repo, "task"), `#!/usr/bin/env bash\ntouch '${repo}/ran'\n`, {
      mode: 0o755,
    });
  }

  /**
   * この作業場の scope。**名前の作り方を試験へ写さない**（#99）——写すと、
   * **本物が名前を変えても、試験は古い名前で緑のまま通る**。**本物に 1 周させて読む。**
   */
  function workerScope(): string {
    const lease = join(repo, "bin", "loop-lease");
    const held = spawnSync(lease, ["acquire", "worker"], { cwd: repo, encoding: "utf8" });
    expect(held.status, `lease を取れない: ${held.stderr}`).toBe(0);
    const name = readdirSync(join(repo, ".git")).find((entry) =>
      entry.startsWith("valence-loop-rounds-worker"),
    );
    expect(name, "周回の印が見つからない").toBeDefined();
    expect(
      spawnSync(lease, ["release", "worker", held.stdout.trim()], { cwd: repo }).status,
      "lease を返せない",
    ).toBe(0);
    return (name ?? "").replace("valence-loop-rounds-", "");
  }

  /**
   * worker の活動と「始めた周回の印」を作る。**worker 自身が書く形と同じ。**
   *
   * **印は lease ではない。** lease は返すと消えるので、それを見ていると
   * **周回と周回の間が「始めていない」と同じ見え方**になり、**何周まわしても
   * 数えられない**（実際にそう書いて指摘された）。
   */
  function workerState(options: {
    activityAgo: number;
    startedAt?: number;
    longestRound?: number;
  }): void {
    const now = Math.floor(Date.now() / 1000);
    const scope = workerScope();
    // **活動の記録は「人が ./task を叩いた」でも新しくなる。**
    // 判定に使っていないことを見るために、**新しいまま置く**
    writeFileSync(
      join(repo, ".git", `valence-loop-activity-${scope}`),
      `${now - options.activityAgo}\n`,
    );
    const rounds = join(repo, ".git", `valence-loop-rounds-${scope}`);
    if (options.startedAt === undefined) {
      rmSync(rounds, { force: true });
    } else {
      writeFileSync(rounds, `${options.startedAt}\n`);
    }
    const longest = join(repo, ".git", `valence-loop-roundlen-${scope}`);
    if (options.longestRound === undefined) {
      rmSync(longest, { force: true });
    } else {
      writeFileSync(longest, `${options.longestRound}\n`);
    }
  }

  /** worker が解く状態の識別子（`bin/loop-stall` の `WORKER_FIXES` にあるもの）。 */
  const WORKER_FIXES_ID = "awaiting-worker:142@abc1234";

  function stall(id = WORKER_FIXES_ID): Run {
    const result = spawnSync(join(repo, "bin", "loop-stall"), [id], {
      cwd: repo,
      encoding: "utf8",
    });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  beforeEach(setup);
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("worker が 1 周しかしていなければ、master が何周しても止めない", () => {
    // **実測で 5 回とも、worker は 1 周も終えていなかった。**
    workerState({ activityAgo: 10, startedAt: Math.floor(Date.now() / 1000) - 600 });

    const results = [stall(), stall(), stall(), stall(), stall()];

    expect(results.map((result) => result.status)).toEqual([0, 0, 0, 0, 0]);
    expect(results.at(-1)?.stdout).toContain("count=0");
  });

  it("周回が 1 つ終われば、持っていなくても数える", () => {
    // **ここが抜けていた。** 印を lease で見ていたので、**返した瞬間に「始めていない」**
    // と同じ見え方になり、**何周まわしても数えられなかった**。
    // **数えたいのは「1 周終えても変わらなかった」**である
    const now = Math.floor(Date.now() / 1000);
    workerState({ activityAgo: 10, startedAt: now - 600 });
    expect(stall().stdout).toContain("count=0");

    // 周回が終わり、次の周回が始まった（印だけが進む。lease は持っていない）
    workerState({ activityAgo: 10, startedAt: now - 300 });

    expect(stall().stdout).toContain("count=1");
  });

  it("worker が周回を重ねても状態が変わらなければ、これまでどおり止める", () => {
    // **ただ猶予を増やすだけにしない。** 心拍が出ていても、**上限ぶんの周回を
    // まわして変わらないなら**止める（`./task` を叩き続けているだけ、の形を通さない）
    const now = Math.floor(Date.now() / 1000);
    for (const [index, ago] of [900, 700, 500, 300].entries()) {
      workerState({ activityAgo: 10, startedAt: now - ago });
      const result = stall();
      if (index < 3) {
        expect(result.status, `${index + 1} 周目で止まっている`).toBe(0);
      } else {
        expect(result.stdout).toContain("[STOP]");
        expect(result.status).toBe(1);
      }
    }
  });

  it("head を読めない状態は、worker の周回で待たない", () => {
    // **主体が違う。** `bin/loop-head same` の exit 2（`gh` / 認証 / GitHub）は
    // **worker の push では解けない**——`review-unanswered` と同じ側である。
    //
    // **「動いた」と同じ名前にまとめると、worker が元気な間ずっと数えられない**
    // （**片方の違反を直すために、もう片方を作る**形。master が自分の指示の誤りとして
    // 挙げた）。**違う状態には違う名前**を打つ
    const now = Math.floor(Date.now() / 1000);
    workerState({ activityAgo: 10, startedAt: now - 600 });

    expect(stall("head-lookup-failed:142").stdout).toContain("count=1");
    expect(stall("head-lookup-failed:142").stdout).toContain("count=2");
    expect(stall("head-lookup-failed:142").stdout).toContain("[STOP]");
  });

  it("head が動いた状態も、worker の周回で数える", () => {
    // **head が動く原因は、worker が push したことである**（#145）。つまり
    // **この停止が起きているとき、worker はほぼ必ず動いている**——
    // **master の周回ごとに数えると、worker が元気に push している間に
    // 3 周で全ループが止まる**（master の指摘）。
    //
    // **狙いは保たれる。** worker の周回ごとに 1 ずつ数えるので、
    // **「worker が push し続ける間 master が判断できない」なら 3 周で人を呼ぶ**
    workerState({ activityAgo: 10, startedAt: Math.floor(Date.now() / 1000) - 600 });

    const results = [1, 2, 3, 4, 5].map(() => stall("head-moved:142"));

    expect(results.map((result) => result.status)).toEqual([0, 0, 0, 0, 0]);
  });

  it("worker が解くとした識別子は、すべて一覧にある", () => {
    // **綴りがずれると黙って効かなくなる。** 主体の一覧（WORKER_FIXES）と
    // 識別子の一覧（STOP_IDS）は別の軸なので別に持つが、**片方だけ直すと食い違う**
    const script = readFileSync(SCRIPT, "utf8");
    const fixes = (/readonly WORKER_FIXES=\(([^)]*)\)/.exec(script)?.[1] ?? "")
      .split("\n")
      .map((line) => line.trim().replace(/"/g, ""))
      // **理由はその識別子の隣に書く。** コメントを識別子として読むと、
      // **書いた瞬間に「一覧に無い」で落ちる**（読み取り側の誤り）
      .filter((line) => line !== "" && !line.startsWith("#"));
    const kinds = listedSpecs().map((spec) => spec.split(":")[0]);

    expect(fixes.length).toBeGreaterThan(0);
    for (const fix of fixes) {
      expect(kinds, `${fix} が一覧に無い`).toContain(fix);
    }
  });

  it("worker が主体でない識別子には、worker の生死を効かせない", () => {
    // **主体が違う。** review-unanswered は「Codex が返さない」ので、
    // **worker が元気に別の周回をまわしていても解けない**
    const now = Math.floor(Date.now() / 1000);
    workerState({ activityAgo: 10, startedAt: now - 600 });

    expect(stall("review-unanswered:142@abc1234").stdout).toContain("count=1");
    expect(stall("review-unanswered:142@abc1234").stdout).toContain("count=2");

    expect(stall("review-unanswered:142@abc1234").stdout).toContain("[STOP]");
  });

  it("印が古ければ、活動が新しくても数える", () => {
    // **ここが本題。** 活動の記録は **人が worker の作業場で `./task` を叩いても**
    // 新しくなるので、**worker が死んだあとも「作業中」に見え続ける**。
    // それを判定に使うと、**カウンタが永久に止まる**（第 4 層が黙って死ぬ側）。
    // **周回の印は `acquire` でしか動かない**ので、そちらで見る
    const now = Math.floor(Date.now() / 1000);
    workerState({ activityAgo: 1, startedAt: now - 7200, longestRound: 600 });

    expect(stall().stdout).toContain("count=1");
    expect(stall().stdout).toContain("count=2");

    expect(stall().stdout).toContain("[STOP]");
  });

  it("長い周回の途中なら、印が同じでも数えない", () => {
    // **窓は実測（いちばん長かった周回）から広げる。** 書き写した閾値だと、
    // **1 周が長い機械で、周回の途中に止められる**
    const now = Math.floor(Date.now() / 1000);
    workerState({ activityAgo: 10, startedAt: now - 3000, longestRound: 3600 });

    const results = [stall(), stall(), stall(), stall()];

    expect(results.map((result) => result.status)).toEqual([0, 0, 0, 0]);
    expect(results.at(-1)?.stdout).toContain("count=0");
  });

  /**
   * 別の作業場の記録を置く。**scope はパスから作る**ので、パスが変われば増える。
   *
   * **周回の印（`startedAgo`）と活動の記録（`activityAgo`）は別に置ける。**
   * **人が `./task` を叩くと活動だけが新しくなる**ので、**食い違う状態**が要る。
   */
  function otherWorkspace(options: {
    longestRound: number;
    startedAgo: number;
    activityAgo: number;
  }): void {
    const now = Math.floor(Date.now() / 1000);
    // **値は「この作業場のものと違う」ことだけが要る。** `bin/loop-stall` は
    // scope を突き合わせるだけで、**そこからパスを読み取らない**（読み取れない）
    const scope = "worker-other-workspace";
    writeFileSync(
      join(repo, ".git", `valence-loop-roundlen-${scope}`),
      `${options.longestRound}\n${options.longestRound}\n`,
    );
    writeFileSync(
      join(repo, ".git", `valence-loop-rounds-${scope}`),
      `${now - options.startedAgo}\n`,
    );
    writeFileSync(
      join(repo, ".git", `valence-loop-activity-${scope}`),
      `${now - options.activityAgo}\n`,
    );
  }

  it("片方の作業場だけが新しい周回を始めても、数えない", () => {
    // **作業場が増えると、無関係な周回で別の PR のカウンタが進む**（#144）。
    // **印を全部の作業場から取って最大値にしていた**ので、**PR を直している worker が
    // 同じ長い周回にいても、別の worker が周回を始めるたびに数が進む**——
    // **別 worker の 3 周だけで全ループを誤停止しうる。**
    //
    // **入力を 2 つ用意する。** **1 つの作業場だけでは、この経路に入らない**
    // （#195 / #196 / #197 / #198 で 4 回続けて踏んだ形）
    const now = Math.floor(Date.now() / 1000);
    workerState({ activityAgo: 10, startedAt: now - 600, longestRound: 600 });
    otherWorkspace({ longestRound: 600, startedAgo: 600, activityAgo: 10 });
    expect(stall().stdout, "1 周目は印を覚えるだけ").toContain("count=0");

    // **もう一方だけが、新しい周回を始めた**（こちらは同じ周回の中にいる）
    otherWorkspace({ longestRound: 600, startedAgo: 1, activityAgo: 10 });

    expect(stall().stdout, "無関係な周回で数が進んでいる").toContain("count=0");
  });

  it("開始時刻がずれていても、全部の作業場が進むまで数えない", () => {
    // **最小値では足りない**（#200 のレビュー）。**最小値を持っていた作業場が動けば、
    // それだけで動く**——**A が 2 周、B が 1 周しか始めていないのに 3 まで達する。**
    //
    // **入力を「ずれている」側にする。** **同じ開始時刻だと、最小値と「全員」が
    // 一致してしまう**（差が無いので、最小値は両方が動いたときにしか動かない）——
    // **今日 5 回目の「差が無い入力」**である
    const now = Math.floor(Date.now() / 1000);
    workerState({ activityAgo: 10, startedAt: now - 700, longestRound: 600 });
    otherWorkspace({ longestRound: 600, startedAgo: 600, activityAgo: 10 });
    expect(stall().stdout, "1 周目は印を覚えるだけ").toContain("count=0");

    // **こちらだけが新しい周回を始めた**（もう一方は同じ周回の中にいる）
    workerState({ activityAgo: 10, startedAt: now - 1, longestRound: 600 });

    expect(stall().stdout, "片方だけで数が進んでいる").toContain("count=0");
  });

  it("どの作業場も新しい周回を始めたら、数える", () => {
    // **混ざらなくすることは、数えなくすることではない**（#47 で塞いだ
    // 「正常に動きながら何も進まない」が、ここに開き直る）。
    // **片方だけ見ると「誰のカウンタも進まない」でも緑になる**
    const now = Math.floor(Date.now() / 1000);
    workerState({ activityAgo: 10, startedAt: now - 600, longestRound: 600 });
    otherWorkspace({ longestRound: 600, startedAgo: 600, activityAgo: 10 });
    expect(stall().stdout).toContain("count=0");

    // **両方が、新しい周回を始めた**
    workerState({ activityAgo: 10, startedAt: now - 1, longestRound: 600 });
    otherWorkspace({ longestRound: 600, startedAgo: 1, activityAgo: 10 });

    expect(stall().stdout, "誰の周回でも数が進まなくなっている").toContain("count=1");
  });

  it("使われなくなった作業場は、数を止め続けない", () => {
    // **「全員が新しい周回を始めたか」で見る**と、**周回を始めなくなった作業場が
    // 1 つあるだけで、数が永久に止まる**——**混ざらなくすることは、数えなくすること
    // ではない**（#47 で塞いだ「正常に動きながら何も進まない」が、ここに開き直る）。
    //
    // **生きている作業場だけを見る**（#175 と同じ判定を、印のほうにも当てる）
    const now = Math.floor(Date.now() / 1000);
    // **窓の外にいる作業場**（600 秒の周回なので窓は 1800 秒。3 時間前は死んでいる）
    otherWorkspace({ longestRound: 600, startedAgo: 10800, activityAgo: 10800 });
    workerState({ activityAgo: 10, startedAt: now - 600, longestRound: 600 });
    expect(stall().stdout).toContain("count=0");

    workerState({ activityAgo: 10, startedAt: now - 1, longestRound: 600 });

    expect(stall().stdout, "死んだ作業場が数を止めている").toContain("count=1");
  });

  it("人が `./task` を叩いても、使われなくなった作業場は生き返らない", () => {
    // **活動の記録は生存に使えない**（このファイルの上のほうに書いてある）——
    // **`./task` は lease の有無に関係なく毎回 heartbeat を打つ**ので、
    // **人がその作業場で 1 回叩けば、長い実測が窓へ戻る**（#175 のレビュー 2 周目）。
    // **周回の開始でしか動かない印（rounds）で見る。**
    const now = Math.floor(Date.now() / 1000);
    workerState({ activityAgo: 1, startedAt: now - 3000, longestRound: 5 });
    // **周回はずっと前で終わっているが、人がいま `./task` を叩いた**
    otherWorkspace({ longestRound: 4000, startedAgo: 100000, activityAgo: 5 });

    expect(stall().stdout, "心拍で死んだ作業場が生き返っている").toContain("count=1");
  });

  it("使われなくなった作業場の実測は、窓に効かせない", () => {
    // **記録は作業場ごとにある**（scope はパスから作る）が、**窓は全部の最大**だった。
    // **長い周回を記録した作業場が使われなくなると、その値は誰も更新しない**ので、
    // **別の作業場で何周しても落ちず、窓は永久に広いまま**になる（#175 のレビュー）。
    // **この機械には既に worker 役の scope が 2 つある**ので、**#82 を待たずに踏む**。
    //
    // **生死の基準を新しく作らない。** **lease の期限は「最後に活動してからの経過」**で
    // 測る既存の基準なので、**そのまま流用する**（活動は `./task` が記録する）。
    const now = Math.floor(Date.now() / 1000);
    const ttl = Number(
      spawnSync(join(repo, "bin", "loop-lease"), ["ttl"], { cwd: repo, encoding: "utf8" }).stdout,
    );
    workerState({ activityAgo: 1, startedAt: now - 3000, longestRound: 5 });
    // **使われていない作業場**（最後の周回がずっと前）に、長い実測が残っている
    otherWorkspace({ longestRound: 4000, startedAgo: 100000, activityAgo: ttl + 60 });

    expect(stall().stdout, "死んだ作業場の実測で窓が広がっている").toContain("count=1");
  });

  it("生きている作業場の実測は、自分のでなくても効かせる", () => {
    // **1 つに絞ると「短いほうへ倒す」になる**（master の指摘）。**軽い Issue の
    // 作業場が新しく、重い Issue の作業場が少し古い**とき、**新しいほうだけを見ると
    // 重いほうが窓の外へ出る**——**#129 / #142 が入れた性質を壊す**。
    // **生きている作業場の中の最大**にする
    const now = Math.floor(Date.now() / 1000);
    workerState({ activityAgo: 1, startedAt: now - 3000, longestRound: 5 });
    // **走っている作業場**（自分の実測から見て、まだ周回の途中でありうる）に長い実測がある
    otherWorkspace({ longestRound: 4000, startedAgo: 2500, activityAgo: 5 });

    expect(stall().stdout, "生きている作業場の実測を捨てている").toContain("count=0");
  });

  it("実測が短くても、窓は既定より狭くしない", () => {
    // **窓の材料は直近 N 回の最大になった** (#146)。**忘れる以上、忘れたあとの 1 回は
    // 既定へ戻る**——**そこから下へは行かない**ようにする。**記録が無いときと同じ
    // 既定（lease の期限）を下限**に置くので、**根拠を新しく作っていない**。
    //
    // **下限が無いと、短い周回が続いたあとの長い周回で止められる**——
    // **#129 / #142 が入れた性質を、忘れる仕組みが壊す**形になる。
    const ttl = Number(
      spawnSync(join(repo, "bin", "loop-lease"), ["ttl"], {
        cwd: repo,
        encoding: "utf8",
      }).stdout.trim(),
    );
    const now = Math.floor(Date.now() / 1000);
    // **ふだんの周回は 5 秒**（窓にすると 10 秒）。いまの周回は既定の半分だけ経っている
    workerState({ activityAgo: 10, startedAt: now - Math.floor(ttl / 2), longestRound: 5 });

    const results = [stall(), stall(), stall()];

    expect(results.at(-1)?.stdout, "既定より狭い窓で数えている").toContain("count=0");
  });

  it("worker が黙ったら、これまでどおり master の周回で数えて止める", () => {
    // **worker が死んだときにカウンタが進まなくなってはいけない**（危険側の穴）。
    // 期限は bin/loop-lease が持つ値を使う（書き写さない）
    const ttl = Number(
      spawnSync(join(repo, "bin", "loop-lease"), ["ttl"], {
        cwd: repo,
        encoding: "utf8",
      }).stdout.trim(),
    );
    workerState({ activityAgo: ttl + 60 });

    expect(stall().stdout).toContain("count=1");
    expect(stall().stdout).toContain("count=2");
    const third = stall();

    expect(third.stdout).toContain("[STOP]");
    expect(third.status).toBe(1);
  });

  it("周回の印が無ければ、これまでどおり数える", () => {
    // **「分からない」は「数える」へ倒す。** 印を書けなかったとき（bin/loop-lease は
    // 書けなくても lease は渡す）や、**この仕組みが入った直後**——活動の記録はあるのに
    // 印はまだ無い——に、**数えないほうへ倒すと第 4 層が黙って死ぬ**
    workerState({ activityAgo: 10 });

    expect(stall().stdout).toContain("count=1");
    expect(stall().stdout).toContain("count=2");

    expect(stall().stdout).toContain("[STOP]");
  });

  it("worker の記録が無ければ、これまでどおり数える", () => {
    // **知らない状態を「作業中」に倒さない。** 倒すと、記録が消えただけで
    // 第 4 層が止まる
    expect(stall().stdout).toContain("count=1");
    expect(stall().stdout).toContain("count=2");

    expect(stall().stdout).toContain("[STOP]");
  });

  it("--reset は数を消すが、worker が黙っている事実は消さない", () => {
    // **人が再開しても、固まったままなら再び止まる。** 活動の記録は毎回読み直すので、
    // --reset で消えるのは数だけである
    const ttl = Number(
      spawnSync(join(repo, "bin", "loop-lease"), ["ttl"], {
        cwd: repo,
        encoding: "utf8",
      }).stdout.trim(),
    );
    workerState({ activityAgo: ttl + 60 });
    stall();
    stall();
    expect(stall().stdout).toContain("[STOP]");

    expect(stall("--reset").status).toBe(0);
    stall();
    stall();

    expect(stall().stdout).toContain("[STOP]");
  });
});

describe("人が再開したことを受け取る", () => {
  // **第 4 層は「3 周続いたら人を呼ぶ」仕組みだが、呼ばれた人が応えたことを
  // 受け取る口が無かった。** `./task loop:resume` はカウンタを消さないので、
  // **人が判断して再開した直後に、同じ条件でもう 1 回で止まり直す**（今日 6 回）。
  //
  // **合図は `resume` である。** STOP は人にしか解けないので、**resume は
  // 「人が来て判断した」唯一の証拠**——ただし**「判断した」であって「直った」ではない**。
  // だから**消すのは数だけ**で、**同じ状態で再び上限に達すれば、そのときは止まる**。

  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "loop-stall-resume-"));
    expect(spawnSync("git", ["init", "--quiet", repo]).status).toBe(0);
    mkdirSync(join(repo, "bin"));
    for (const name of ["loop-stall", "loop-lease"]) {
      copyFileSync(join(REPO_ROOT, "bin", name), join(repo, "bin", name));
      chmodSync(join(repo, "bin", name), 0o755);
    }
    writeFileSync(join(repo, "task"), `#!/usr/bin/env bash\ntouch '${repo}/ran'\n`, {
      mode: 0o755,
    });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function stall(id: string): Run {
    const result = spawnSync(join(repo, "bin", "loop-stall"), [id], {
      cwd: repo,
      encoding: "utf8",
    });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  it("再開の合図は数を消す", () => {
    // **人が手で --reset を打たなくてよくする**（今日 6 回打っている）
    stall("no-work");
    stall("no-work");
    expect(stall("no-work").stdout).toContain("[STOP]");

    expect(stall("--resumed").status).toBe(0);

    expect(stall("no-work").stdout).toContain("count=1");
  });

  it("再開しても、直っていなければ上限でまた止まる", () => {
    // **ただ消すだけにしない。** 人が何もせず再開しただけなら、
    // **これまでどおりの周回数で止まる**
    stall("no-work");
    stall("no-work");
    stall("no-work");
    stall("--resumed");

    stall("no-work");
    stall("no-work");

    expect(stall("no-work").stdout).toContain("[STOP]");
  });

  it("2 回目の停止は、そう分かる形で出る", () => {
    // **同じところで繰り返し止まっていることが、記録から読めるようにする。**
    // 消しただけだと「1 回目と同じ」に見え、**人が同じ判断を繰り返していることに
    // 誰も気づけない**
    stall("no-work");
    stall("no-work");
    stall("no-work");
    stall("--resumed");
    stall("no-work");
    stall("no-work");

    expect(stall("no-work").stdout).toMatch(/2 回目/);
  });

  it("カウンタを消せなければ、成功を返さない", () => {
    // **`task` は終了コードで「消せたか」を判断し、消せなければ STOP を残す。**
    // ここで握りつぶすと、**約束した側が、約束を測る値を返していない**ことになる。
    // 倒れる向きも悪い——**カウンタが残ったまま STOP が消える**ので、
    // **再開直後に 1 周で止まり直す**（#127 の症状が、#127 を直す経路の中に残る）
    stall("no-work");
    const gitDir = join(repo, ".git");
    chmodSync(gitDir, 0o555);
    const resumed = stall("--resumed");
    chmodSync(gitDir, 0o755);

    expect(resumed.status).not.toBe(0);
    expect(resumed.stderr).toContain("消せません");
  });

  it("カウンタが無ければ、成功する", () => {
    // **`rm -f` は「ファイルが無い」では失敗しない。** ここを止めると
    // **初回の resume が通らなくなる**（まだ 1 度も記録していない状態）
    const resumed = stall("--resumed");

    expect(resumed.status).toBe(0);
  });

  it("止まっていない識別子は、繰り返しに数えない", () => {
    // **上限に達したものだけが「人を呼んだ」状態である**
    stall("no-work");
    stall("dirty");
    stall("dirty");
    expect(stall("dirty").stdout).toContain("[STOP]");
    stall("--resumed");

    stall("no-work");
    stall("no-work");

    expect(stall("no-work").stdout).not.toMatch(/2 回目/);
  });

  it("./task loop:resume が再開の合図を通す", () => {
    // **人が打つのは resume 1 つだけ**にする。手順書に「--reset も打つこと」と
    // 書き足す形にしない（#143 と同じ理由——書いてあっても飛ばす）
    const real = mkdtempSync(join(tmpdir(), "loop-stall-resume-task-"));
    expect(spawnSync("git", ["init", "--quiet", real]).status).toBe(0);
    mkdirSync(join(real, "bin"));
    for (const name of ["loop-stall", "loop-lease"]) {
      copyFileSync(join(REPO_ROOT, "bin", name), join(real, "bin", name));
      chmodSync(join(real, "bin", name), 0o755);
    }
    copyFileSync(join(REPO_ROOT, "task"), join(real, "task"));
    chmodSync(join(real, "task"), 0o755);
    const run = (args: string[]) =>
      spawnSync(join(real, "bin", "loop-stall"), args, { cwd: real, encoding: "utf8" });
    run(["no-work"]);
    run(["no-work"]);

    expect(spawnSync("./task", ["loop:resume"], { cwd: real, encoding: "utf8" }).status).toBe(0);
    const after = run(["no-work"]);
    rmSync(real, { recursive: true, force: true });

    expect(after.stdout).toContain("count=1");
  });
});

describe("止まっていないのに、止めたと言わない", () => {
  // **止める仕組みが、止めずに「止めた」と言う経路がある** (#190)。**2 層ある。**
  //
  //   1. `cmd_loop_stop` が**プロセス置換**で置き場所を読む——**取得の失敗が
  //      `while` へ伝わらない**ので、**1 つも作らずに最終行だけを出して 0 で終わる**
  //   2. `bin/loop-stall` が**その戻り値を見ていない**——**片方だけ直しても素通りする**
  //
  // **ここは第 4 層そのもの**である。**同じ状態が 3 周続き、人を呼ぶと決めた瞬間**に
  // 黙って失敗すると、**`[STOP]` は出るのにどのループも止まらない**——
  // **人は「止まった、あとで見よう」と読む。**

  let repo: string;

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("置き場所を取れなければ、止めたと言わない", () => {
    // **git の外に置く。** `loop_stop_paths` の `git worktree list` が落ちる
    // ——**cwd にも親にもリポジトリが無い**状態である
    repo = mkdtempSync(join(tmpdir(), "loop-stop-nogit-"));
    copyFileSync(join(REPO_ROOT, "task"), join(repo, "task"));
    chmodSync(join(repo, "task"), 0o755);

    const stopped = spawnSync("./task", ["loop:stop", "ためし"], { cwd: repo, encoding: "utf8" });

    expect(stopped.status, "1 つも作れていないのに成功している").not.toBe(0);
    expect(stopped.stdout, "止めたと言っている").not.toContain(
      "全ループが次の周回の冒頭で停止する",
    );
  });

  it("取得が失敗したら、出力があっても使わない", () => {
    // **「1 つも作れなかった」と「取得に失敗した」は別である。** 出力が空になる形だけを
    // 見ていると、**どちらの見張りが効いているのか分からない**——**出力があるまま失敗する
    // 形**を作って、**受けた値の状態を見ているほう**を押さえる
    repo = mkdtempSync(join(tmpdir(), "loop-stop-partial-"));
    expect(spawnSync("git", ["init", "--quiet", repo]).status).toBe(0);
    copyFileSync(join(REPO_ROOT, "task"), join(repo, "task"));
    chmodSync(join(repo, "task"), 0o755);
    const stubs = join(repo, "stub");
    mkdirSync(stubs);
    const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(
      join(stubs, "git"),
      [
        "#!/usr/bin/env bash",
        // **並べたあとで落ちる。** 途中まで出す git は実在する（壊れた worktree など）
        'if [[ $1 == "worktree" && $2 == "list" ]]; then',
        `  printf 'worktree %s\\n' "${repo}"`,
        "  exit 1",
        "fi",
        `exec "${realGit}" "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const stopped = spawnSync("./task", ["loop:stop", "ためし"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubs}:${process.env.PATH ?? ""}` },
    });

    expect(stopped.status, "取れていないのに成功している").not.toBe(0);
    expect(existsSync(join(repo, "loop", "STOP")), "取れていない値で止めている").toBe(false);
  });

  it("並んだ結果が 1 つも無ければ、止めたと言わない", () => {
    // **取得は成功しても、置き場所が 1 つも出ないことはある**——**porcelain の書式が
    // 変われば `awk` が 1 行も拾わない**。**そのときも、止めたことにはならない**
    repo = mkdtempSync(join(tmpdir(), "loop-stop-empty-"));
    expect(spawnSync("git", ["init", "--quiet", repo]).status).toBe(0);
    copyFileSync(join(REPO_ROOT, "task"), join(repo, "task"));
    chmodSync(join(repo, "task"), 0o755);
    const stubs = join(repo, "stub");
    mkdirSync(stubs);
    const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(
      join(stubs, "git"),
      [
        "#!/usr/bin/env bash",
        // **成功するが、拾える行が 1 つも無い**（書式が変わった形）
        'if [[ $1 == "worktree" && $2 == "list" ]]; then',
        "  echo 'path /somewhere'",
        "  exit 0",
        "fi",
        `exec "${realGit}" "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const stopped = spawnSync("./task", ["loop:stop", "ためし"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubs}:${process.env.PATH ?? ""}` },
    });

    expect(stopped.status, "1 つも止めていないのに成功している").not.toBe(0);
    expect(stopped.stdout, "止めたと言っている").not.toContain(
      "全ループが次の周回の冒頭で停止する",
    );
  });

  it("途中まで止まっていたら、止まっていないとは言わない", () => {
    // **worktree ごとに書くので、途中で落ちうる**（権限・ディスク）。**そこまでは
    // 止まっている**のに、**「どのループも止まっていません」と言うと逆の誤解になる**
    // ——**人は「まだ全部走っている」と読み、止まっている側を放置する**（#191 のレビュー）
    repo = mkdtempSync(join(tmpdir(), "loop-stop-partial-write-"));
    expect(spawnSync("git", ["init", "--quiet", repo]).status).toBe(0);
    mkdirSync(join(repo, "bin"));
    for (const name of ["loop-stall", "loop-lease"]) {
      copyFileSync(join(REPO_ROOT, "bin", name), join(repo, "bin", name));
      chmodSync(join(repo, "bin", name), 0o755);
    }
    copyFileSync(join(REPO_ROOT, "task"), join(repo, "task"));
    chmodSync(join(repo, "task"), 0o755);
    spawnSync("git", ["-C", repo, "add", "-A"]);
    spawnSync("git", [
      "-C",
      repo,
      "-c",
      "user.email=loop@example.invalid",
      "-c",
      "user.name=loop",
      "commit",
      "--quiet",
      "-m",
      "init",
    ]);
    const worktree = `${repo}-wt`;
    expect(
      spawnSync("git", ["-C", repo, "worktree", "add", "--detach", "--quiet", worktree]).status,
      "worktree を作れない",
    ).toBe(0);
    // **2 つ目だけ書けなくする。** 1 つ目は止まり、2 つ目で落ちる
    chmodSync(worktree, 0o555);

    let result = spawnSync(join(repo, "bin", "loop-stall"), ["dirty"], {
      cwd: repo,
      encoding: "utf8",
    });
    for (let index = 0; index < 2; index += 1) {
      result = spawnSync(join(repo, "bin", "loop-stall"), ["dirty"], {
        cwd: repo,
        encoding: "utf8",
      });
    }
    const stoppedFirst = existsSync(join(repo, "loop", "STOP"));
    chmodSync(worktree, 0o755);
    spawnSync("git", ["-C", repo, "worktree", "remove", "--force", worktree]);
    rmSync(worktree, { recursive: true, force: true });

    expect(stoppedFirst, "1 つ目も止まっていない（前提が崩れている）").toBe(true);
    expect(result.stderr, "止まっていないと断定している").not.toContain(
      "どのループも止まっていません",
    );
    expect(result.stderr, "全部を止められなかったことが出ていない").toContain("全 worktree");
    // **どこまで止まったかが読めること。** 「失敗した」だけだと、**人は残りを探せない**
    expect(result.stderr, "どこまで作れたかが出ていない").toContain("ここまでに 1 個は作成済み");
  });

  it("止められなかったら、bin/loop-stall が [FAIL] を出す", () => {
    // **[STOP] だけで終わると、人は止まったと読む。** **`task` を非ゼロで返すように
    // しても、呼ぶ側が見ていなければ素通りする**——**両方を見る**
    repo = mkdtempSync(join(tmpdir(), "loop-stop-fails-"));
    expect(spawnSync("git", ["init", "--quiet", repo]).status).toBe(0);
    mkdirSync(join(repo, "bin"));
    copyFileSync(join(REPO_ROOT, "bin", "loop-stall"), join(repo, "bin", "loop-stall"));
    chmodSync(join(repo, "bin", "loop-stall"), 0o755);
    // **止められない `task`。** 失敗を隠さずに返す
    writeFileSync(
      join(repo, "task"),
      '#!/usr/bin/env bash\nif [[ $1 == "loop:stop" ]]; then echo "止められない" >&2; exit 1; fi\nexit 0\n',
      { mode: 0o755 },
    );

    let result = spawnSync(join(repo, "bin", "loop-stall"), ["dirty"], {
      cwd: repo,
      encoding: "utf8",
    });
    for (let index = 0; index < 2; index += 1) {
      result = spawnSync(join(repo, "bin", "loop-stall"), ["dirty"], {
        cwd: repo,
        encoding: "utf8",
      });
    }

    expect(result.stdout, "上限に達していない").toContain("[STOP]");
    expect(result.stderr, "止められなかったことが出ていない").toContain("[FAIL]");
    // **終了コードで分ける** (#191 のレビュー)。**読む側が分岐に使うのはここ**なので、
    // **標準エラーへ書いても分岐は変わらない**——**「止まった」と「止まらなかった」が
    // `exit 1` で同じだと、手順書の「exit 1 → 全ループが停止済み」が嘘になる**
    expect(result.status, "止まっていないのに「停止済み」と同じ値を返している").not.toBe(1);
  });
});

describe("再開の順番", () => {
  // **カウンタを消すことと STOP を消すことは、同じ排他区間で行う** (#151)。
  //
  //   t0    --resumed がカウンタを消して返る
  //   t0+ε  走っていた周回が bin/loop-stall を呼び、上限に達して **STOP を作る**
  //   t0+1s 削除がその STOP を消す
  //   結果  **止まるべきなのに再開する**——人には「削除」しか見えない
  //
  // **窓が狭いから起きない、とは言えない。** **STOP は周回の冒頭でしか効かない**ので、
  // **STOP を置いた時点で走っていた周回は最後まで走り切る**——**人が resume を打つのは
  // たいていその最中**である。狭いのは窓の幅であって、巡り合わせの珍しさではない。
  //
  // **順番は読んでも正しく見える**ので、**入れ替わったことを検出できる形**で見る。

  let repo: string;
  let state: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "loop-resume-order-"));
    expect(spawnSync("git", ["init", "--quiet", repo]).status).toBe(0);
    state = join(repo, ".git", "valence-loop-stall");
    mkdirSync(join(repo, "bin"));
    copyFileSync(join(REPO_ROOT, "task"), join(repo, "task"));
    chmodSync(join(repo, "task"), 0o755);
    copyFileSync(join(REPO_ROOT, "bin", "loop-stall"), join(repo, "bin", "loop-stall"));
    chmodSync(join(repo, "bin", "loop-stall"), 0o755);
    mkdirSync(join(repo, "loop"));
    writeFileSync(join(repo, "loop", "STOP"), "とめた\n");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  /**
   * 偽の `task`。**置き場所を聞かれた時点でカウンタがまだあるか**を書き残す。
   * **順番そのものを見る**ためのもので、「呼ばれた」だけでは入れ替わりを検出できない。
   */
  function withTask(options: { failsOnPaths?: boolean } = {}): void {
    writeFileSync(
      join(repo, "task"),
      [
        "#!/usr/bin/env bash",
        ...(options.failsOnPaths === true
          ? ['if [[ $1 == "loop:stop:paths" ]]; then echo "取れない" >&2; exit 1; fi']
          : []),
        `if [[ -e "${join(repo, ".git", "valence-loop-stall")}" ]]; then`,
        `  echo "state-present $*" >> "${join(repo, "order.log")}"`,
        "else",
        `  echo "state-absent $*" >> "${join(repo, "order.log")}"`,
        "fi",
        'if [[ $1 == "loop:stop:paths" ]]; then',
        `  printf '%s\\n' "${join(repo, "loop", "STOP")}"`,
        "fi",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  }

  /** カウンタを 1 つ作る。**消す対象が無いと、順番を見られない。** */
  function counted(): void {
    expect(
      spawnSync(join(repo, "bin", "loop-stall"), ["dirty"], { cwd: repo, encoding: "utf8" }).status,
      "カウンタを作れない",
    ).toBe(0);
    expect(existsSync(state), "カウンタが無い").toBe(true);
  }

  function resume(): { status: number; stdout: string; stderr: string } {
    const result = spawnSync(join(repo, "bin", "loop-stall"), ["--resumed"], {
      cwd: repo,
      encoding: "utf8",
    });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  it("カウンタを消してから STOP を消す", () => {
    // **逆だと、隙間に入った周回が STOP を作り直したあとでカウンタが消える**
    counted();
    withTask();

    expect(resume().status).toBe(0);

    expect(readFileSync(join(repo, "order.log"), "utf8")).toContain("state-absent loop:stop:paths");
    expect(existsSync(join(repo, "loop", "STOP"))).toBe(false);
  });

  it("カウンタを消せなければ、STOP を消さない", () => {
    // **消えたのに古いカウンタが残る**と、再開した直後に 1 周で止まり直す
    // （#127 の症状そのもの）。**消せないなら、再開しないほうがよい**
    counted();
    withTask();
    // **書き込めないディレクトリでは消せない。** ロックのファイルは既にあるので開ける
    chmodSync(join(repo, ".git"), 0o555);
    const result = resume();
    chmodSync(join(repo, ".git"), 0o755);

    expect(result.status).not.toBe(0);
    expect(existsSync(join(repo, "loop", "STOP")), "STOP が消えている").toBe(true);
    expect(result.stderr).toContain("停止カウンタを消せません");
  });

  it("置き場所を取れなければ、再開を成功にしない", () => {
    // **プロセス置換の終了状態は `while` へ伝わらない**（#189 のレビュー）。
    // **取れなかったのに 0 件と読むと**、**カウンタだけ消えて STOP は残ったまま**なのに
    // **「STOP は無い（停止していない）」と言って成功で終わる**——
    // **人には再開できたように見え、ループは止まったまま**になる
    counted();
    withTask({ failsOnPaths: true });

    const result = resume();

    expect(result.status, "取れなかったのに成功している").not.toBe(0);
    expect(result.stdout, "0 件と読んでいる").not.toContain("STOP は無い");
    expect(existsSync(join(repo, "loop", "STOP")), "STOP が消えている").toBe(true);
  });

  it("./task loop:resume は、その区間へ通す", () => {
    // **人が打つのは resume 1 つだけ**である。**区間の中でカウンタと STOP の
    // 両方が片付く**ことを、本物の `task` で見る
    counted();

    const result = spawnSync("./task", ["loop:resume"], { cwd: repo, encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(repo, "loop", "STOP")), "STOP が残っている").toBe(false);
    expect(existsSync(state), "カウンタが残っている").toBe(false);
  });

  /**
   * 本物の `bin/loop-stall` を `real-loop-stall` として置き、
   * **窓に 1 周ぶん差し込む包み**を `bin/loop-stall` にする（#151）。
   *
   * **窓は「`--resumed` が返ってから、STOP が消されるまで」**である。
   * **順番を正しくしても、ロックの外にあるかぎり残る**——**そこへ実際に周回を入れる。**
   */
  function withRoundInTheWindow(): void {
    const real = join(repo, "bin", "real-loop-stall");
    copyFileSync(join(REPO_ROOT, "bin", "loop-stall"), real);
    chmodSync(real, 0o755);
    writeFileSync(
      join(repo, "bin", "loop-stall"),
      [
        "#!/usr/bin/env bash",
        `"${real}" "$@"; status=$?`,
        // **走っていた周回が、ちょうどここで上限に達する。** STOP を作り直す
        'if [[ $1 == "--resumed" && $status -eq 0 ]]; then',
        `  "${real}" dirty >/dev/null 2>&1`,
        "fi",
        "exit $status",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  }

  it("再開の途中で上限に達した周回の STOP を、消さない", () => {
    // **上限を 1 にすると成立する**（#151）。**踏めるかどうかは値で決まるが、
    // 窓そのものは値と無関係**——**カウンタの操作と STOP の削除が別プロセス**で、
    // **ロックの外に隙間がある**。
    //
    // **既定の 3 で踏まないのは、窓に入れる周回が 2 つしかないから**である。
    // **作業場が増えれば 3 でも届く**（#82）ので、**下限を検査で縛る形では追えない**。
    withRoundInTheWindow();

    const resumed = spawnSync("./task", ["loop:resume"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, LOOP_MAX_STALL_REPEATS: "1" },
    });

    expect(resumed.status).toBe(0);
    expect(
      existsSync(join(repo, "loop", "STOP")),
      "走っていた周回が作った STOP を、再開処理が消している",
    ).toBe(true);
  });
});
