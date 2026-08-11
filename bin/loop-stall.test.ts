import { execFileSync, type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MODELLED_SPAWNS } from "../test/slow-machine";

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

  it("--reset は識別子の検査を通さずカウンタを消す", () => {
    const reset = run(["--reset"], sandbox);

    expect(reset.status).toBe(0);
    expect(run(["wrong-branch:12"], sandbox).stdout).toContain("count=1");
  });
});

describe("上限に達したときに止める対象", () => {
  /**
   * スクリプトのコピーと偽の `task` を使い、上限まで走らせる。
   * **本物の bin/loop-stall をそのまま上限まで走らせない。** それをやると実際に
   * 実リポジトリの両 worktree が停止する（この Issue の事故そのもの）。
   *
   * 偽の `task` は「呼ばれた印」を残すだけ。**呼ばれてはいけない側にも置く**ので、
   * 実行されたかどうかがそのまま判定になる。
   */
  function runToLimit(options: { cwd: "same-repo" | "other-repo" }): {
    status: number;
    stderr: string;
    ranScriptRepoTask: boolean;
    ranCwdRepoTask: boolean;
  } {
    const scriptRepo = mkdtempSync(join(tmpdir(), "loop-stall-script-"));
    const otherRepo = mkdtempSync(join(tmpdir(), "loop-stall-cwd-"));
    for (const repo of [scriptRepo, otherRepo]) {
      spawnSync("git", ["init", "--quiet", repo]);
      // 呼ばれたことだけを残す task。本物のように loop/STOP は配らない
      writeFileSync(join(repo, "task"), `#!/usr/bin/env bash\ntouch '${repo}/ran'\n`, {
        mode: 0o755,
      });
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

  it("cwd が別のリポジトリなら、止めなかった理由を出す", () => {
    // 黙って何もしないのは、黙って止めるのと同じくらい分かりにくい
    const result = runToLimit({ cwd: "other-repo" });

    expect(result.status).toBe(1);
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
    const result = runToLimit({ cwd: "same-repo" });

    expect(result.status).toBe(1);
    expect(result.ranScriptRepoTask).toBe(true);
  });

  it("実リポジトリの loop/STOP は作られない", () => {
    runToLimit({ cwd: "other-repo" });

    expect(existsSync(join(REPO_ROOT, "loop", "STOP"))).toBe(false);
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
    const id = `changes-requested:50@${sha}`;
    const result = runNoWorkToLimit([id, id, id]);

    expect(result.status).toBe(1);
    expect(result.stops).toEqual([true, true]);
  });

  it("worker が push した周回は数え直す（SHA が変わる）", () => {
    // 対応が進んでいるあいだに止めない
    const a = `changes-requested:50@${"a".repeat(40)}`;
    const b = `changes-requested:50@${"b".repeat(40)}`;
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

  it("ロックが取られている間は待ち、解放されてから数える", () => {
    // **カウンタは master と worker が同じ周期で書きうる。** 読んでから書くまでを
    // 排他しないと、後から書いた側が相手の増分を消す（記録が増えないまま周回が進み、
    // **どちらの識別子も上限に届かない**）。
    const { repo, script, state } = makeRepo();
    // 先に 1 回書いて、ロック対象のファイルを作っておく
    spawnSync(script, ["no-work"], { cwd: repo, encoding: "utf8" });
    // 外から 1 秒ロックを保持し、**待たされた時間**を見る。
    // 「結果が正しい」だけでは、ロックを取らない実装でも通ってしまう
    const holder = spawnSync(
      "/usr/bin/bash",
      [
        "-c",
        `flock '${state}.lock' -c 'sleep 1' &
         sleep 0.2
         start=$(date +%s%N)
         '${script}' no-work
         end=$(date +%s%N)
         echo "elapsed_ms=$(( (end - start) / 1000000 ))"
         wait`,
      ],
      { cwd: repo, encoding: "utf8", env: { ...process.env, LOOP_MAX_STALL_REPEATS: "99" } },
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
    const result = spawnSync(
      "/usr/bin/bash",
      [
        "-c",
        `flock '${state}.lock' -c 'sleep 2' &
         sleep 0.2
         '${script}' no-work
         echo "stall_exit=$?"
         wait`,
      ],
      {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, LOOP_STALL_LOCK_WAIT_SEC: "1" },
      },
    );
    const counted = readFileSync(state, "utf8");
    rmSync(repo, { recursive: true, force: true });

    // ラッパーではなく **loop-stall 自身の終了コード**を見る
    expect(result.stdout).toContain("stall_exit=2");
    expect(result.stderr).toContain("ロック");
    // 数えていないこと（1 のまま）
    expect(counted).toContain("1\tno-work");
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
    const scope = `worker${repo.replace(/\//g, "_")}`;
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
  const WORKER_FIXES_ID = "blocking-findings:142@abc1234";

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

  it("worker が解くとした識別子は、すべて一覧にある", () => {
    // **綴りがずれると黙って効かなくなる。** 主体の一覧（WORKER_FIXES）と
    // 識別子の一覧（STOP_IDS）は別の軸なので別に持つが、**片方だけ直すと食い違う**
    const script = readFileSync(SCRIPT, "utf8");
    const fixes = (/readonly WORKER_FIXES=\(([^)]*)\)/.exec(script)?.[1] ?? "")
      .split("\n")
      .map((line) => line.trim().replace(/"/g, ""))
      .filter((line) => line !== "");
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
