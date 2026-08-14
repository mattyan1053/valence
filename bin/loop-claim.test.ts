import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { holdLock } from "../test/held-lock";
import { MODELLED_HOOK_SPAWNS } from "../test/slow-machine";

const SCRIPT = fileURLToPath(new URL("./loop-claim", import.meta.url));
const LEASE = fileURLToPath(new URL("./loop-lease", import.meta.url));
const STAMP = fileURLToPath(new URL("./loop-procedure-stamp", import.meta.url));

/** **`acquire` は手順書の印を受け取る** (#243 のレビュー)。**実物と同じ呼び方にする。** */
function workerStamp(): string {
  return spawnSync(STAMP, ["worker"], { encoding: "utf8" }).stdout.trim();
}

type Run = { status: number; stdout: string; stderr: string };

describe("bin/loop-claim", () => {
  let repo: string;
  let path: string;
  let state: string;
  let log: string;

  /**
   * 偽の `gh`。**Issue の label だけを持つ。**
   *
   * `issue view` をわざと遅くするのは、**読んでから書くまでの窓を広げる**ためである。
   * 窓が無いと、直列化を外しても取り合いが再現せず、**変異が赤くならない**。
   */
  function withGh(options: { labels: string[]; editIsNoop?: boolean; viewDelay?: string }): void {
    writeFileSync(state, options.labels.join("\n"));
    writeFileSync(log, "");
    writeFileSync(
      join(path, "gh"),
      [
        "#!/usr/bin/env bash",
        'if [[ $* == *"issue view"* ]]; then',
        `  sleep ${options.viewDelay ?? "0.4"}`,
        `  cat ${JSON.stringify(state)}`,
        "  exit 0",
        "fi",
        'if [[ $* == *"issue edit"* ]]; then',
        `  echo "edit" >>${JSON.stringify(log)}`,
        ...(options.editIsNoop === true ? [] : [`  echo "in-progress" >${JSON.stringify(state)}`]),
        "  exit 0",
        "fi",
        'echo "スタブ: 想定外の gh 呼び出し: $*" >&2',
        "exit 2",
      ].join("\n"),
      { mode: 0o755 },
    );
  }

  /** 同じリポジトリの作業場を足す。**共通ディレクトリは共有される**ので、記録も共有される。 */
  function addWorkspace(name: string): string {
    const dir = join(repo, name);
    const result = spawnSync("git", ["-C", repo, "worktree", "add", "--detach", dir], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    return dir;
  }

  /** **同時に**走らせる。`spawnSync` の繰り返しは直列で、同時性を試せない（#74 の前例）。 */
  function race(jobs: { args: string[]; cwd?: string }[]): Promise<Run[]> {
    return Promise.all(
      jobs.map((job) => {
        return new Promise<Run>((resolve) => {
          const child = spawn(
            "bash",
            [
              "-c",
              `printf 'start %s\\n' "$(date +%s%N)" >>"$RACE_LOG"; ` +
                `${JSON.stringify(SCRIPT)} ${job.args.join(" ")}; code=$?; ` +
                `printf 'end %s\\n' "$(date +%s%N)" >>"$RACE_LOG"; exit $code`,
            ],
            {
              cwd: job.cwd ?? repo,
              env: { ...process.env, PATH: path, RACE_LOG: join(repo, "race.log") },
            },
          );
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => {
            stdout += String(chunk);
          });
          child.stderr.on("data", (chunk) => {
            stderr += String(chunk);
          });
          child.on("close", (code) => resolve({ status: code ?? -1, stdout, stderr }));
        });
      }),
    );
  }

  /** すべてのプロセスが走り出してから、最初の 1 つが終わったか。**直列なら成り立たない。** */
  function overlapped(): boolean {
    const marks = readFileSync(join(repo, "race.log"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [kind, at] = line.split(" ");
        return { kind, at: BigInt(at ?? "0") };
      });
    const starts = marks.filter((mark) => mark.kind === "start").map((mark) => mark.at);
    const ends = marks.filter((mark) => mark.kind === "end").map((mark) => mark.at);
    if (starts.length === 0 || starts.length !== ends.length) {
      return false;
    }
    return starts.reduce((a, b) => (a > b ? a : b)) < ends.reduce((a, b) => (a < b ? a : b));
  }

  function run(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Run {
    const result = spawnSync(SCRIPT, args, {
      cwd: options.cwd ?? repo,
      encoding: "utf8",
      env: { ...process.env, PATH: path, ...options.env },
      timeout: 20_000,
    });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  /** 作業場で周回を始める（`describe` をまたいで使う）。 */
  function startRoundOutside(cwd: string): string {
    const result = spawnSync(LEASE, ["acquire", "worker", workerStamp()], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PATH: path },
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  }

  function endRoundOutside(cwd: string, token: string): void {
    const result = spawnSync(LEASE, ["release", "worker", token], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PATH: path },
    });
    expect(result.status, result.stderr).toBe(0);
  }

  function editCount(): number {
    return readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line === "edit").length;
  }

  beforeEach(() => {
    // **hook の枠もここから導いてある**（test/slow-machine.ts の MODELLED_HOOK_SPAWNS）。
    // **数え違いは起こす側で検出する**——見積もりと合わなければここで落ちる。
    // 本体だけ枠を伸ばしても、**本体へ到達する前に hook が時間切れになる**
    let hookSpawns = 0;
    function counted(
      command: string,
      args: string[],
      env?: NodeJS.ProcessEnv,
    ): SpawnSyncReturns<string> {
      hookSpawns += 1;
      return spawnSync(command, args, { encoding: "utf8", env });
    }

    repo = mkdtempSync(join(tmpdir(), "loop-claim-"));
    expect(counted("git", ["init", "--quiet", repo]).status).toBe(0);
    // 作業場を足すには commit が 1 つ要る
    expect(
      counted("git", ["-C", repo, "commit", "--allow-empty", "--quiet", "-m", "init"], {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@e",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@e",
      }).status,
    ).toBe(0);
    path = join(repo, "path");
    mkdirSync(path, { recursive: true });
    state = join(repo, "labels");
    log = join(repo, "edits");
    writeFileSync(join(repo, "race.log"), "");
    for (const command of [
      "bash",
      "git",
      "flock",
      "cat",
      "date",
      "sleep",
      "rm",
      "mv",
      "cp",
      "grep",
      "printf",
      "kill",
      "setsid",
      "touch",
      // **lease を実際に取る**ために要る（#237 のレビュー。PR の記録は、
      // **持ち主の周回が走っているか**で決まる）
      "sha256sum",
      "od",
      "tr",
    ]) {
      const found = counted("which", [command]).stdout.trim();
      if (found !== "") {
        symlinkSync(found, join(path, command));
      }
    }
    chmodSync(path, 0o755);

    expect(hookSpawns, "hook が起こすプロセスの数が見積もりと違う").toBe(MODELLED_HOOK_SPAWNS);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  describe("take — ready の Issue を取る", () => {
    it("同時に取りに行っても、取れるのは 1 つだけ", async () => {
      // **これが本題。** label を付けるだけだと、両方が「空いている」と読んでから両方が書ける
      withGh({ labels: ["ready"] });

      const results = await race(Array.from({ length: 4 }, () => ({ args: ["take", "84"] })));

      expect(results.filter((result) => result.status === 0)).toHaveLength(1);
      expect(results.filter((result) => result.status === 1)).toHaveLength(3);
      // **書き込みそのものも 1 回だけ。** exit だけ見ると、2 回書いてから譲っても通る
      expect(editCount()).toBe(1);
    });

    it("試したときに、本当に重なっている", async () => {
      // **同時性そのものが主題。** 直列に走らせていると、直列化を外す変異が赤くならない
      // （#74 でそうなった）
      withGh({ labels: ["ready"] });

      await race(Array.from({ length: 4 }, () => ({ args: ["take", "84"] })));

      expect(overlapped()).toBe(true);
    });

    it("取れなかった側は、待たされずに戻る", async () => {
      // **待つと、そこが新しい詰まりどころになる**（#74 の lease と同じ判断）
      withGh({ labels: ["ready"] });
      const holder = spawn("flock", [
        "-x",
        join(repo, ".git", "valence-loop-claim.lock"),
        "sleep",
        "20",
      ]);
      await new Promise((resolve) => setTimeout(resolve, 300));

      const result = run(["take", "84"], { env: { LOOP_CLAIM_LOCK_WAIT_SEC: "1" } });
      holder.kill();

      expect(result.status).toBe(1);
      expect(editCount()).toBe(0);
    });

    it("書いたのに変わっていなければ、取れたことにしない", () => {
      // **書き込んでから読み直して確かめる。** 書けたつもりで進むと、
      // **label は ready のまま実装が始まり**、次の周回がもう一度同じものを取る
      withGh({ labels: ["ready"], editIsNoop: true, viewDelay: "0" });

      expect(run(["take", "84"]).status).toBe(2);
    });

    it("すでに ready が外れていれば取れない", () => {
      withGh({ labels: ["in-progress"], viewDelay: "0" });

      expect(run(["take", "84"]).status).toBe(1);
    });

    it("Issue を読めなければ 2 で落ちる", () => {
      // **判定不能を「取れた」に倒さない。** 倒すと 2 人が同じものを実装する
      writeFileSync(join(path, "gh"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });

      expect(run(["take", "84"]).status).toBe(2);
    });
  });

  describe("resume — in-progress の Issue を続けてよいか", () => {
    it("別の作業場が取った Issue は再開しない", () => {
      // **これが #100 のレビューで見つかった穴。** ステップ 2.2 は label しか見ておらず、
      // **claim を通らずに実装へ入れた**。取った側がブランチを作る前の窓がそのまま重複になる
      withGh({ labels: ["ready"], viewDelay: "0" });
      const other = addWorkspace("other");
      expect(run(["take", "84"], { cwd: other }).status).toBe(0);

      expect(run(["resume", "84"]).status).toBe(1);
    });

    it("自分が取った Issue は再開できる", () => {
      // **中断した自分の作業は拾えなければならない。** 2.2 はそのための経路である
      withGh({ labels: ["ready"], viewDelay: "0" });
      expect(run(["take", "84"]).status).toBe(0);

      expect(run(["resume", "84"]).status).toBe(0);
    });

    it("持ち主の記録が無ければ拾える", () => {
      // **落ちた周回が Issue を永久に抱え込まないこと。** 記録が無い＝生きている持ち主が
      // 居ないので、2.2 の本来の役目（公開に失敗した周回を拾う）へ倒す
      withGh({ labels: ["in-progress"], viewDelay: "0" });

      expect(run(["resume", "84"]).status).toBe(0);
    });

    it("期限を過ぎた記録は引き継げる", () => {
      // **落ちた周回の跡である。** 黙って上書きせず、引き継いだことを標準エラーに残す
      withGh({ labels: ["ready"], viewDelay: "0" });
      const other = addWorkspace("other");
      expect(run(["take", "84"], { cwd: other }).status).toBe(0);

      const resumed = run(["resume", "84"], { env: { LOOP_CLAIM_TTL_SEC: "0" } });

      expect(resumed.status).toBe(0);
      expect(resumed.stderr).toContain("WARN");
    });

    it("引き継いだら、持ち主は自分になる", () => {
      // **引き継ぎっぱなしにしない。** 記録が前の持ち主のままだと、
      // **次の周回でまた誰でも引き継げる**（排他が 1 回きりになる）
      withGh({ labels: ["ready"], viewDelay: "0" });
      const other = addWorkspace("other");
      expect(run(["take", "84"], { cwd: other }).status).toBe(0);
      expect(run(["resume", "84"], { env: { LOOP_CLAIM_TTL_SEC: "0" } }).status).toBe(0);

      expect(run(["resume", "84"], { cwd: other }).status).toBe(1);
    });

    it("in-progress でなければ再開しない", () => {
      // 2.2 が見るのは着手中のものだけである。**ready を横から取らない**
      withGh({ labels: ["ready"], viewDelay: "0" });

      expect(run(["resume", "84"]).status).toBe(1);
    });

    it("取ろうとしている周回と、再開しようとしている周回が同時でも、進むのは 1 つだけ", async () => {
      // **claim を通らない側が問題だった**ので、そこを競合させる。
      // ロックのどちらが先でも成り立つ: resume が先なら label がまだ ready なので譲り、
      // take が先なら記録の持ち主が違うので譲る
      withGh({ labels: ["ready"] });
      const other = addWorkspace("other");

      const results = await race([
        { args: ["take", "84"], cwd: other },
        { args: ["resume", "84"] },
        { args: ["resume", "84"] },
        { args: ["resume", "84"] },
      ]);

      expect(overlapped()).toBe(true);
      expect(results.filter((result) => result.status === 0)).toHaveLength(1);
    });
  });

  /**
   * **#202 でブランチを掴まなくなり、git の worktree 排他が偶然かけていた錠が外れた**
   * （#203）。**掴んでいたときは「同じ PR を 2 人が直す」を git が止めていた。**
   *
   * **Issue 側と同じ形にする。** 持ち主は作業場、記録は共通ディレクトリ、
   * 譲るのは後から入った側——**語彙を増やさない。**
   */
  describe("pr — レビュー対応の前に PR を取る", () => {
    /** 作業場で周回を始める。**PR の記録は、持ち主の周回が走っている間だけ効く。** */
    function startRound(cwd: string): string {
      const result = spawnSync(LEASE, ["acquire", "worker", workerStamp()], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, PATH: path },
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    }

    function endRound(cwd: string, token: string): void {
      const result = spawnSync(LEASE, ["release", "worker", token], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, PATH: path },
      });
      expect(result.status, result.stderr).toBe(0);
    }

    /** 記録を、取ってから長く経った形にする。**時間で判定していれば、ここで奪われる。** */
    function backdateRecord(pr: string, secondsAgo: number): void {
      const record = join(repo, ".git", `valence-loop-claim-pr-${pr}`);
      const [owner] = readFileSync(record, "utf8").trim().split("\t");
      writeFileSync(record, `${owner}\t${Math.floor(Date.now() / 1000) - secondsAgo}\n`);
    }

    it("持ち主の周回が走っている間は、取れない", () => {
      // **これが本題。** 両方が同じ SHA から直し始めると、**重複返信**と
      // **片方の push が non-fast-forward で落ちる**
      withGh({ labels: [] });
      startRound(repo);
      expect(run(["pr", "42"]).status, "1 人目が取れていない").toBe(0);

      const second = run(["pr", "42"], { cwd: addWorkspace("second") });

      expect(second.status).toBe(1);
    });

    it("取れなかった側は、黙って進まない", () => {
      // **無言で飛ばすと、2 人居るのに 1 人で回っているように見える。**
      // **判定不能が別の理由に化ける**のと同じ形である
      withGh({ labels: [] });
      startRound(repo);
      run(["pr", "42"]);

      const second = run(["pr", "42"], { cwd: addWorkspace("second") });

      // **`作業場` や `[WARN]` だけを見ない。** **`bin/loop-lease check` が
      // 冒頭で同じ語を出している**ので、**排他を外しても緑のままになる**
      // （実際に、変異させたらこの本だけ通った）。**この分岐だけが出す形で見る。**
      expect(second.status, "取れてしまっている").toBe(1);
      expect(second.stderr, "何の話か分からない").toContain("PR #42");
    });

    it("長い周回でも、動いている持ち主から奪わない", () => {
      // **時間で測らない** (#237 のレビュー)。**レビュー対応は `./task check` を回すので
      // 1800 秒を超えうる**——**測っているのは「取ってからの経過」だが、知りたいのは
      // 「持ち主が生きているか」**である。**この PR が消しに来たものが、期限の側から戻ってくる。**
      withGh({ labels: [] });
      startRound(repo);
      run(["pr", "42"]);
      backdateRecord("42", 100_000);

      const second = run(["pr", "42"], { cwd: addWorkspace("second") });

      expect(second.status, "動いている持ち主から奪っている").toBe(1);
    });

    it("同じ作業場なら、何周でも取れる", () => {
      // **明日の朝いちで動くのは、いまと同じ 1 人の worker である。**
      // **1 人で回している限り、これまでどおり通ること**
      withGh({ labels: [] });
      startRound(repo);

      expect(run(["pr", "42"]).status).toBe(0);
      expect(run(["pr", "42"]).status, "自分が取った PR に入れない").toBe(0);
    });

    it("別の PR は、取り合いにならない", () => {
      withGh({ labels: [] });
      startRound(repo);
      run(["pr", "42"]);

      expect(run(["pr", "43"], { cwd: addWorkspace("other") }).status).toBe(0);
    });

    it("持ち主の周回が終わっていれば、引き継げる", () => {
      // **落ちた周回の跡で、その PR が誰にも直せなくなってはいけない**
      // （**`release` を作らない**判断は、これで成り立っている）。
      // **黙って奪わない**ので、引き継いだことは残す
      withGh({ labels: [] });
      const token = startRound(repo);
      run(["pr", "42"]);
      endRound(repo, token);

      const second = run(["pr", "42"], { cwd: addWorkspace("later") });

      expect(second.status).toBe(0);
      // **`[WARN]` だけを見ない**（`bin/loop-lease check` も出す。上記と同じ理由）。
      // **`bin/loop-lease` の「lease が期限切れでした…引き継ぎます」とも重なる**ので、
      // **PR 番号と一緒に見る**
      expect(second.stderr, "黙って奪っている").toMatch(/PR #42.*引き継ぎます/);
    });

    it("持ち主の作業場に置かれたものを実行しない", () => {
      // **訊きに行く先が、相手の版になっていた** (#237 のレビュー)。
      // **相手の作業場は `gh pr checkout` で PR の head に入っている**ので、
      // **その PR が書き換えた `bin/loop-lease` を実行しうる**——**#219 と同じ形**
      // （**head の版を実行しない**）。**壊れ方は静かで、`busy` の答えを変える PR が
      // 乗っていると、生きている持ち主を「走っていない」と読む。**
      withGh({ labels: [] });
      startRound(repo);
      run(["pr", "42"]);
      // **持ち主の作業場に、違う答えを返す版を置く**（PR の head に入っている状態）
      mkdirSync(join(repo, "bin"), { recursive: true });
      writeFileSync(
        join(repo, "bin", "loop-lease"),
        "#!/usr/bin/env bash\nexit 1\n", // 「どこも走っていない」と答える版
        { mode: 0o755 },
      );

      // **手順書と同じ呼び方（相対パス）で走らせる。**
      // **絶対パスで呼ぶと `${BASH_SOURCE[0]%/*}` が絶対になり、この穴は再現しない**
      // ——**呼ばれ方まで含めて写す**
      const second = addWorkspace("second");
      mkdirSync(join(second, "bin"), { recursive: true });
      symlinkSync(SCRIPT, join(second, "bin", "loop-claim"));
      symlinkSync(
        fileURLToPath(new URL("./loop-lease", import.meta.url)),
        join(second, "bin", "loop-lease"),
      );
      const result = spawnSync("bash", ["-c", "bin/loop-claim pr 42"], {
        cwd: second,
        encoding: "utf8",
        env: { ...process.env, PATH: path },
      });

      expect(result.status, "持ち主の作業場の版を実行している").toBe(1);
    });

    it("走っているかどうかを読めないなら、取らない", () => {
      // **判定不能は、取れなかった側でも取れた側でもない。**
      // **作業場の入っていない lease** があると、`bin/loop-lease busy` は「読めない」を返す
      withGh({ labels: [] });
      startRound(repo);
      run(["pr", "42"]);
      writeFileSync(
        join(repo, ".git", "valence-loop-lease-worker-broken"),
        `tok\t${Math.floor(Date.now() / 1000)}\n\n\n`,
      );

      const second = run(["pr", "42"], { cwd: addWorkspace("unreadable") });

      expect(second.status, "読めないのに取っている").toBe(2);
    });

    it("別の周回が取っている最中なら、譲る", () => {
      // **判定不能に倒さない**（倒すと、取り合いのたびに周回が止まる）。
      // `take` と同じ扱いである
      withGh({ labels: [] });
      const held = holdLock({ dir: repo, lock: join(repo, ".git", "valence-loop-claim.lock") });

      try {
        expect(run(["pr", "42"], { env: { LOOP_CLAIM_LOCK_WAIT_SEC: "1" } }).status).toBe(1);
      } finally {
        held.release();
      }
    });

    it("使い方の誤りは、取れなかったと混ぜない", () => {
      withGh({ labels: [] });

      expect(run(["pr"]).status).toBe(2);
      expect(run(["pr", "#42"]).status).toBe(2);
      expect(run(["pr", "42", "余計な引数"]).status).toBe(2);
    });
  });

  /**
   * **上限は「1 人あたり 1 本」のまま、全体で 2 本になる**（#85）。
   * **`--author @me` は 2 人分を返す**ので、**そのまま数えると 1 人目が止まる**——
   * **数えるのは自分の作業場のものだけ**である。
   */
  describe("mine — その PR を自分の作業場が持っているか", () => {
    it("自分が取った PR は、自分のもの", () => {
      withGh({ labels: [] });
      run(["pr", "42"]);

      expect(run(["mine", "42"]).status).toBe(0);
    });

    it("別の作業場が取った PR は、数えない", () => {
      // **これが本題。** **数えると、2 人目が動いているだけで 1 人目が止まる**
      withGh({ labels: [] });
      run(["pr", "42"]);

      expect(run(["mine", "42"], { cwd: addWorkspace("second") }).status).toBe(1);
    });

    it("記録が無いものは、まだ誰のものでもない", () => {
      // **数える側では取らない** (#238 のレビュー 2 周目)。**「数える前に持ち主を
      // 決める」をそのまま当てると、先に走った作業場が記録の無い PR を全部取り、
      // 「1 人が両方持って止まる」に置き換わるだけ**である（#184 の形が残る）。
      // **取るのは空き枠のぶんだけ**で、**それは `bin/loop-claim pr` が 1 本ずつ行う。**
      withGh({ labels: [] });

      expect(run(["mine", "42"]).status).toBe(1);
      // **記録も作らない**——**残しておけば、別の作業場が 1 本目として取れる**
      expect(run(["mine", "42"], { cwd: addWorkspace("other") }).status).toBe(1);
    });

    it("走っているかどうかは見ない", () => {
      // **数えるのは周回をまたぐ**（PR は次の周回でレビュー対応する）ので、
      // **`pr` の「持ち主が生きているか」とは別の判定**である
      withGh({ labels: [] });
      const token = startRoundOutside(repo);
      run(["pr", "42"]);
      endRoundOutside(repo, token);

      expect(run(["mine", "42"]).status).toBe(0);
      expect(run(["mine", "42"], { cwd: addWorkspace("third") }).status).toBe(1);
    });

    it("使い方の誤りは、持っていないと混ぜない", () => {
      withGh({ labels: [] });

      expect(run(["mine"]).status).toBe(2);
      expect(run(["mine", "#42"]).status).toBe(2);
    });
  });

  describe("audit — label と実態の食い違いを見つける", () => {
    /** open PR の本文と、Issue ごとの label を返す偽の `gh`。 */
    function withAudit(options: {
      /** **本文は渡さない。** `Closes` の書き方を自分で解析しない（GitHub に訊く）。 */
      prs?: { number: number; closes: number[]; repo?: string }[];
      labelsOf?: Record<number, string[]>;
      /** label の付け替えが失敗する。**部分的に成功した状態を作らせない**ための試験。 */
      editFails?: boolean;
      /** 付け替えが**成功を返すのに何も変わらない**。`gh` は通らなくても 0 を返しうる。 */
      editIsNoop?: boolean;
    }): void {
      const prs = (options.prs ?? []).map((pr) => String(pr.number)).join("\n");
      const closesOf = (options.prs ?? [])
        .map(
          (pr) =>
            `    ${pr.number}) printf '%b' ${JSON.stringify(
              pr.closes.map((n) => `${pr.repo ?? "owner/repo"}\t${n}`).join("\n"),
            )}; echo; exit 0 ;;`,
        )
        .join("\n");

      // **label は状態として持つ。** 付け替えたら見えるようにしないと、
      // **「書いたら読み直す」を試験できない**（読み直しても同じ値が返ってしまう）
      const labelsDir = join(repo, "labels");
      mkdirSync(labelsDir, { recursive: true });
      for (const [number, labels] of Object.entries(options.labelsOf ?? {})) {
        writeFileSync(join(labelsDir, number), `${labels.join("\n")}\n`);
      }

      writeFileSync(
        join(path, "gh"),
        [
          "#!/usr/bin/env bash",
          `labels_dir=${JSON.stringify(labelsDir)}`,
          'if [[ $* == *"api graphql"* ]]; then',
          `  printf '%b' ${JSON.stringify(prs)}`,
          `  [[ -n ${JSON.stringify(prs)} ]] && echo`,
          "  exit 0",
          "fi",
          'if [[ $* == *"repo view"* ]]; then',
          '  echo "owner"',
          '  echo "repo"',
          "  exit 0",
          "fi",
          // **閉じる Issue は GitHub に訊く。** 本文を自分で解析しない
          'if [[ $* == *"closingIssuesReferences"* ]]; then',
          "  for word in $*; do",
          "    case $word in",
          closesOf,
          "    esac",
          "  done",
          "  exit 0",
          "fi",
          'if [[ $* == *"issue edit"* ]]; then',
          `  echo "$*" >>${JSON.stringify(join(repo, "edits.log"))}`,
          ...(options.editFails === true ? ["  exit 1"] : []),
          ...(options.editIsNoop === true
            ? ["  exit 0"]
            : [
                "  number=$3",
                '  file="$labels_dir/$number"',
                '  tmp="$file.tmp"',
                '  cp "$file" "$tmp" 2>/dev/null || : >"$tmp"',
                "  while (($# > 0)); do",
                '    if [[ $1 == "--remove-label" ]]; then',
                '      grep -vx "$2" "$tmp" >"$tmp.2" || true',
                '      mv "$tmp.2" "$tmp"',
                "    fi",
                '    [[ $1 == "--add-label" ]] && echo "$2" >>"$tmp"',
                "    shift",
                "  done",
                '  mv "$tmp" "$file"',
                "  exit 0",
              ]),
          "fi",
          'if [[ $* == *"issue view"* ]]; then',
          "  for word in $*; do",
          '    if [[ -f "$labels_dir/$word" ]]; then cat "$labels_dir/$word"; exit 0; fi',
          "  done",
          "  exit 0",
          "fi",
          'echo "スタブ: 想定外の gh 呼び出し: $*" >&2',
          "exit 2",
        ].join("\n"),
        { mode: 0o755 },
      );
    }

    /** claim の記録を作る。**実在の古い記録は使わない**（次の操作で消える）。 */
    function writeRecord(number: number, owner = repo): void {
      writeFileSync(join(repo, ".git", `valence-loop-claim-${number}`), `${owner}\t1000\n`);
    }

    it("in-progress でない Issue を閉じる open PR を見つける", () => {
      // **`ready` は「まだ誰も着手していない」を意味する。** そのまま PR があると、
      // **2 人目が同じ Issue を取れる**（#84 / #100 が防ごうとした形そのもの）
      withAudit({ prs: [{ number: 12, closes: [73] }], labelsOf: { 73: ["ready"] } });

      const audited = run(["audit"]);

      expect(audited.status).toBe(1);
      expect(audited.stdout).toContain("73");
    });

    it("in-progress なら食い違いではない", () => {
      withAudit({
        prs: [{ number: 12, closes: [73] }],
        labelsOf: { 73: ["in-progress"] },
      });

      expect(run(["audit"]).status).toBe(0);
    });

    it("着手中でない Issue の記録は、古いものとして解放する", () => {
      // **記録が指す Issue が `in-progress` でないなら、その記録は古い**——
      // **状態から機械的に分かる**ので、呼ぶ場所を散文で並べない（#92 と同じ理由）
      withAudit({ labelsOf: { 82: ["backlog"] } });
      writeRecord(82);

      const audited = run(["audit"]);

      expect(existsSync(join(repo, ".git", "valence-loop-claim-82"))).toBe(false);
      expect(audited.stdout).toContain("82");
    });

    it("着手中の記録は残す", () => {
      withAudit({ labelsOf: { 84: ["in-progress"] } });
      writeRecord(84);

      run(["audit"]);

      expect(existsSync(join(repo, ".git", "valence-loop-claim-84"))).toBe(true);
    });

    it("古い記録があるだけでは止めない", () => {
      // **自動で直せるものは直す。** 止めるのは人の判断が要るほうだけ
      withAudit({ labelsOf: { 82: ["backlog"] } });
      writeRecord(82);

      expect(run(["audit"]).status).toBe(0);
    });

    /**
     * ロックを握らせてから `body` を動かす。
     *
     * **待ち合わせを「速さ」ではなく「事実」で取る。** `sleep` で間を空ける形にすると、
     * **遅い環境では握る前に本体が走って落ち**、**速い環境では永久に気づけない**
     * （手元で緑・CI で赤、を実際に踏んだ）。**握ったと相手が知らせてから**動かす。
     */
    function withHeldLock(body: () => void): void {
      // **仕掛けは `test/held-lock.ts` が持つ。** ここに同じものを書くと、
      // **片方だけ直して漏れる側が残る**——実際に `bin/loop-stall.test.ts` と並んでいて、
      // **41 本が最大 19 時間**生き残った（#153）。
      //
      // **`finally` に頼らない。** 打ち切られた経路では走らないので、
      // **待機側が自分の上限で消える**ようにしてある
      const held = holdLock({ dir: repo, lock: join(repo, ".git", "valence-loop-claim.lock") });

      try {
        body();
      } finally {
        held.release();
      }
    }

    it("見つけたら、その Issue を blocked へ移す", () => {
      // **記録するだけでは防止にならない。** 次の周回で `take` できてしまい、
      // **進捗が出るとカウンタが消える**——**止めたかった当の出来事が記録を消す**。
      // **その 1 件だけを止める**（全ループは進める）
      withAudit({ prs: [{ number: 12, closes: [73] }], labelsOf: { 73: ["ready"] } });

      const audited = run(["audit"]);

      expect(audited.status).toBe(1);
      expect(readFileSync(join(repo, "edits.log"), "utf8")).toMatch(/issue edit 73.*blocked/);
    });

    it("label を付け替えられなければ、止めたことにしない", () => {
      // **付けるほうだけ成功して外すほうが失敗すると、`ready` が残る**——
      // `take` は `ready` だけを見るので、**止めたつもりで取られる**。
      // **1 回の付け替えにまとめる**ので、部分的に成功した状態がそもそも作れない
      withAudit({
        prs: [{ number: 12, closes: [73] }],
        labelsOf: { 73: ["ready"] },
        editFails: true,
      });

      const audited = run(["audit"]);

      expect(audited.status).toBe(2);
      expect(audited.stdout).not.toContain("blocked へ移しました");
    });

    it("別のリポジトリの Issue には触らない", () => {
      // **closing keyword は `Fixes owner/other#73` のような別リポジトリ参照も扱える。**
      // 番号だけに潰すと、**こちらの無関係な #73 を blocked にする**
      withAudit({
        prs: [{ number: 12, closes: [73], repo: "owner/other" }],
        labelsOf: { 73: ["ready"] },
      });

      const audited = run(["audit"]);

      expect(audited.status).toBe(0);
      expect(existsSync(join(repo, "edits.log"))).toBe(false);
    });

    it("in-progress と ready が併存していたら、正常扱いしない", () => {
      // **`take` は `ready` の有無だけを見る**ので、併存したまま通すと
      // **別の作業場が取れる**——`in-progress` があるだけでは足りない
      withAudit({
        prs: [{ number: 12, closes: [73] }],
        labelsOf: { 73: ["in-progress", "ready"] },
      });

      expect(run(["audit"]).status).toBe(1);
    });

    it("backlog も同じ 1 回で外す", () => {
      // **残すと、master のステップ 6 が `ready` へ昇格させうる**——
      // 「その 1 件だけを止める」が成立しない
      withAudit({ prs: [{ number: 12, closes: [73] }], labelsOf: { 73: ["backlog"] } });

      run(["audit"]);

      expect(readFileSync(join(repo, "edits.log"), "utf8")).toMatch(/--remove-label backlog/);
    });

    it("付け替えが成功を返しても、変わっていなければ止まる", () => {
      // **`gh` は通らなくても 0 を返しうる**（`take` が同じ理由で読み直している）。
      // 変わっていないのに「移しました」と言うと、**ロックを離した後で取られる**
      withAudit({
        prs: [{ number: 12, closes: [73] }],
        labelsOf: { 73: ["ready"] },
        editIsNoop: true,
      });

      const audited = run(["audit"]);

      expect(audited.status).toBe(2);
      expect(audited.stdout).not.toContain("blocked へ移しました");
    });

    it("ready が付いていれば、同じ 1 回で外す", () => {
      withAudit({ prs: [{ number: 12, closes: [73] }], labelsOf: { 73: ["ready"] } });

      run(["audit"]);

      const edits = readFileSync(join(repo, "edits.log"), "utf8").trim().split("\n");
      expect(edits).toHaveLength(1);
      expect(edits[0]).toMatch(/--add-label blocked.*--remove-label ready/);
    });

    it("ロックを取れないなら、label にも触らない", () => {
      // **移す前に `take` される窓**を作らない（P1 で直したのと同じ理由）
      withAudit({ prs: [{ number: 12, closes: [73] }], labelsOf: { 73: ["ready"] } });
      withHeldLock(() => {
        expect(run(["audit"], { env: { LOOP_CLAIM_LOCK_WAIT_SEC: "1" } }).status).toBe(2);
        expect(existsSync(join(repo, "edits.log"))).toBe(false);
      });
    });

    it("読めなければ 2 で落ちる", () => {
      writeFileSync(join(path, "gh"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });

      expect(run(["audit"]).status).toBe(2);
    });

    it("消せなかったら、消したことにしない", () => {
      // **失敗を黙って成功にしない。** 消えていない記録は残り続け、
      // **別の作業場の再開を妨げ続ける**（手順書 3.1 の掃除と同じ扱い）
      withAudit({ labelsOf: { 82: ["backlog"] } });
      writeRecord(82);
      // **ロックのファイルは先に作っておく。** 作れないところで止まると、
      // **消せなかった場合まで辿れない**（緑になっても理由が違う）
      writeFileSync(join(repo, ".git", "valence-loop-claim.lock"), "");
      const holder = join(repo, ".git");
      chmodSync(holder, 0o555);

      try {
        const audited = run(["audit"]);

        expect(audited.status).toBe(2);
        expect(audited.stdout).not.toContain("解放しました");
      } finally {
        chmodSync(holder, 0o755);
      }
    });

    it("記録の確認と削除は、take と同じロックの中で行う", () => {
      // **ロックの外で読んだ値を中で使わない。** 読んでから消すまでに `take` が
      // 入ると、**いま書かれた記録を消す**——`take` が塞いだのと同じ形が、
      // **塞ぐ側に開く**（#124 のレビュー指摘）
      withAudit({ labelsOf: { 82: ["backlog"] } });
      writeRecord(82);
      withHeldLock(() => {
        // **ロックを取れないうちは、記録に触らない。**
        const audited = run(["audit"], { env: { LOOP_CLAIM_LOCK_WAIT_SEC: "1" } });

        expect(audited.status).toBe(2);
        expect(existsSync(join(repo, ".git", "valence-loop-claim-82"))).toBe(true);
      });
    });
  });

  it("使い方の誤りは 2 で落ちる", () => {
    withGh({ labels: ["ready"], viewDelay: "0" });

    expect(run([]).status).toBe(2);
    expect(run(["take"]).status).toBe(2);
    expect(run(["take", "84", "余計な引数"]).status).toBe(2);
    expect(run(["take", "#84"]).status).toBe(2);
    expect(run(["grab", "84"]).status).toBe(2);
  });
});
