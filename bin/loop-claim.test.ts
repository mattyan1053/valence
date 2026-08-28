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
      // **`sha256sum` はここに無い** (#383)——**lease の識別子は `git hash-object`
      // で取る**ので、**無いままで実際に取れることを、ここで確かめている。**
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
      // **claim を通らずに実装へ入れた**。取った側がブランチを作る前の窓がそのまま重複になる。
      //
      // **取るのは周回の中である** (#296)。**`take` を打つのは `acquire` を通った周回**
      // なので、**周回の印を置いてから試す**——**印の無い作業場は「回っていない」**である
      withGh({ labels: ["ready"], viewDelay: "0" });
      const other = addWorkspace("other");
      expect(run(["take", "84"], { cwd: other }).status).toBe(0);
      const token = startRoundOutside(other);

      const resumed = run(["resume", "84"]);

      endRoundOutside(other, token);
      expect(resumed.status).toBe(1);
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

    it("周回を回していない持ち主からは引き継げる", () => {
      // **落ちた周回の跡である。** 黙って上書きせず、引き継いだことを標準エラーに残す。
      //
      // **時間では測らない** (#296)。**持ち主の作業場が周回を回しているか**で決める
      // ——**ここでは `other` が周回を始めていない**ので、引き継げる
      withGh({ labels: ["ready"], viewDelay: "0" });
      const other = addWorkspace("other");
      expect(run(["take", "84"], { cwd: other }).status).toBe(0);

      const resumed = run(["resume", "84"]);

      expect(resumed.status).toBe(0);
      expect(resumed.stderr).toContain("WARN");
    });

    it("持ち主が周回を回していれば、記録が古くても引き継がない", () => {
      // **これが #296。** **claim の記録を触った時刻で測っていた**ので、
      // **PR を持つ worker（`mine <PR>` からステップ 3 へ入り `resume` を打たない）**が
      // **生きたまま Issue を取り上げられた**（2026-08-15 に実測）。
      //
      // **期限を 0 にしても引き継がない**——**測るものが時刻ではなくなったからである**
      withGh({ labels: ["ready"], viewDelay: "0" });
      const other = addWorkspace("other");
      expect(run(["take", "84"], { cwd: other }).status).toBe(0);
      const token = startRoundOutside(other);

      const resumed = run(["resume", "84"], { env: { LOOP_CLAIM_TTL_SEC: "0" } });

      endRoundOutside(other, token);
      expect(resumed.status, "生きている持ち主から取り上げている").toBe(1);
      expect(resumed.stderr).toContain("実装中");
    });

    it("周回を終えた直後の持ち主からも、引き継がない", () => {
      // **worker は周回と周回の間、lease を持っていない** (#296)。
      // **「いま lease を握っているか」で測ると、次の周回で戻ってくる作業場から
      // 取り上げる**——**周回の印は返しても消えない**ので、そちらで測る
      withGh({ labels: ["ready"], viewDelay: "0" });
      const other = addWorkspace("other");
      expect(run(["take", "84"], { cwd: other }).status).toBe(0);
      endRoundOutside(other, startRoundOutside(other));

      expect(run(["resume", "84"], { env: { LOOP_CLAIM_TTL_SEC: "0" } }).status).toBe(1);
    });

    it("持ち主が生きているか読めなければ、引き継がない", () => {
      // **判定不能は、取り上げる側へ倒さない**（#296。**待つほうが安い**）
      withGh({ labels: ["ready"], viewDelay: "0" });
      const other = addWorkspace("other");
      expect(run(["take", "84"], { cwd: other }).status).toBe(0);
      const scope = spawnSync(LEASE, ["scope", "worker"], { cwd: other, encoding: "utf8" });
      expect(scope.status, scope.stderr).toBe(0);
      writeFileSync(
        join(repo, ".git", `valence-loop-rounds-${scope.stdout.trim()}`),
        "こわれている\n",
      );

      expect(run(["resume", "84"]).status, "読めないのに取り上げている").toBe(2);
    });

    it("引き継いだら、持ち主は自分になる", () => {
      // **引き継ぎっぱなしにしない。** 記録が前の持ち主のままだと、
      // **次の周回でまた誰でも引き継げる**（排他が 1 回きりになる）
      withGh({ labels: ["ready"], viewDelay: "0" });
      const other = addWorkspace("other");
      expect(run(["take", "84"], { cwd: other }).status).toBe(0);
      // **`other` は周回を回していない**ので引き継げる（#296）
      expect(run(["resume", "84"]).status).toBe(0);
      const token = startRoundOutside(repo);

      const back = run(["resume", "84"], { cwd: other });

      endRoundOutside(repo, token);
      expect(back.status).toBe(1);
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
      // **取るのは周回の中である** (#296)。**`take` を打つ側は `acquire` を通っている**
      // ので、**その印を置いてから競わせる**——**置かないと「回っていない持ち主」に
      // なり、resume が正しく引き継いでしまう**（**競合の試験にならない**）
      const token = startRoundOutside(other);

      const results = await race([
        { args: ["take", "84"], cwd: other },
        { args: ["resume", "84"] },
        { args: ["resume", "84"] },
        { args: ["resume", "84"] },
      ]);

      endRoundOutside(other, token);
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

    /** その作業場の周回の印を、窓の外へ戻す。**落ちた作業場と同じ見え方にする。** */
    function ageRoundOf(cwd: string): void {
      const scope = spawnSync(LEASE, ["scope", "worker"], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, PATH: path },
      }).stdout.trim();
      expect(scope, "作業場の名前を作れない").not.toBe("");
      const ttl = Number(
        spawnSync(LEASE, ["ttl"], {
          cwd: repo,
          encoding: "utf8",
          env: { ...process.env, PATH: path },
        }).stdout.trim(),
      );
      expect(Number.isFinite(ttl) && ttl > 0, "期限を読めない").toBe(true);
      writeFileSync(
        join(repo, ".git", `valence-loop-rounds-${scope}`),
        `${Math.floor(Date.now() / 1000) - ttl - 60}\n`,
      );
    }

    it("周回と周回の間にいるだけの持ち主からは、取らない", () => {
      // **これが #306 の本題。** **`pr` は「いま走っているか」（`busy`）で測っていたので、
      // 返した直後の持ち主から取れてしまった**——**取られた側は次の周回で自分の PR を
      // 直せない**（2.1 も 2.2 も `bin/loop-claim pr` が exit 1 になる）。
      //
      // **`resume` は同じ場面で「実装中」と答える**（`alive`）。**同じ作業場の生死に
      // 2 つの答えがあった。**
      withGh({ labels: [] });
      const token = startRound(repo);
      run(["pr", "42"]);
      endRound(repo, token);

      const second = run(["pr", "42"], { cwd: addWorkspace("between") });

      expect(second.status, "周回の合間にいる持ち主から取っている").toBe(1);
    });

    it("PR と Issue で、同じ答えを返す", () => {
      // **食い違いそのものを見る。** **どちらか一方だけ直しても、この本は落ちる**
      withGh({ labels: ["in-progress"] });
      const token = startRound(repo);
      run(["pr", "42"]);
      run(["resume", "42"]);
      endRound(repo, token);

      const other = addWorkspace("both");
      const asPr = run(["pr", "42"], { cwd: other });
      const asResume = run(["resume", "42"], { cwd: other });

      expect(asPr.status, `pr=${asPr.status} / resume=${asResume.status}`).toBe(asResume.status);
    });

    it("持ち主が周回を回さなくなっていれば、引き継げる", () => {
      // **落ちた周回の跡で、その PR が誰にも直せなくなってはいけない**
      // （**`release` を作らない**判断は、これで成り立っている）。
      // **黙って奪わない**ので、引き継いだことは残す。
      //
      // **「返した直後」ではなく「周回を回さなくなった」で測る** (#306)——
      // **窓を過ぎるまでは、次の周回で戻ってくる作業場**である
      withGh({ labels: [] });
      const token = startRound(repo);
      run(["pr", "42"]);
      endRound(repo, token);
      ageRoundOf(repo);

      const second = run(["pr", "42"], { cwd: addWorkspace("later") });

      expect(second.status).toBe(0);
      // **`[WARN]` だけを見ない**（`bin/loop-lease check` も出す。上記と同じ理由）。
      // **`bin/loop-lease` の「lease が期限切れでした…引き継ぎます」とも重なる**ので、
      // **PR 番号と一緒に見る**
      expect(second.stderr, "黙って奪っている").toMatch(/PR #42.*引き継ぎます/);
    });

    it("引き継ぐときは、どれだけ無音だったかも読める", () => {
      // **判定は `bin/loop-lease` が持ち、言うのもそちら**である (#456)——**ここで
      // 見るのは「その言葉が、引き継ぐ人に届くか」**である（**`alive` の標準エラーを
      // 捨てると、`[WARN] 引き継ぎます` だけが残る**）。
      //
      // **実際に、無音の長さを知らないまま引き継いだ**（2026-08-24。生きている
      // 持ち主の PR を取り、#454 で同じ直しを 2 人で実装した）。
      withGh({ labels: [] });
      startRound(repo); // **返さない**——**期限切れの記録が残る形**にする
      run(["pr", "42"]);
      const scope = spawnSync(LEASE, ["scope", "worker"], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, PATH: path },
      }).stdout.trim();
      const state = join(repo, ".git", `valence-loop-lease-${scope}`);
      const lines = readFileSync(state, "utf8").split("\n");
      const quiet = Math.floor(Date.now() / 1000) - 9000;
      lines[0] = `${(lines[0] ?? "").split("\t")[0] ?? ""}\t${quiet}`;
      writeFileSync(state, lines.join("\n"));
      writeFileSync(join(repo, ".git", `valence-loop-activity-${scope}`), `${quiet}\n`);
      ageRoundOf(repo);

      const second = run(["pr", "42"], { cwd: addWorkspace("quiet") });

      expect(second.status).toBe(0);
      expect(second.stderr, "無音の長さが、引き継ぐ側に届いていない").toMatch(
        /静かになってから 9\d{3} 秒/,
      );
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
      // **作業場の入っていない lease** があると、`bin/loop-lease` は「読めない」を返す。
      //
      // **持ち主の lease は先に返しておく** (#306)。**`alive` は握っている lease を
      // 先に見る**ので、**持ち主が握ったままだと「生きている」と断定できてしまい、
      // 読めない記録まで進まない**——**それはそれで「取らない」だが、
      // ここで見たいのは判定不能のほうである。**
      withGh({ labels: [] });
      const token = startRound(repo);
      run(["pr", "42"]);
      endRound(repo, token);
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
  describe("release — 自分が取った PR の claim を返す", () => {
    /** 作業場で周回を始める。 */
    function startRound(cwd: string): string {
      const result = spawnSync(LEASE, ["acquire", "worker", workerStamp()], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, PATH: path },
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    }

    /**
     * **間違って取った claim を、持ち主が返せること**（#307 のレビュー）。
     *
     * **`pr` を `alive` へ寄せると、持ち主が周回を回している限り窓が開かない**
     * ——**取り違えた claim は、その作業場が 30 分以上まったく回さなくなるまで
     * 誰にも取り返せない。** **返す口が無いと、その PR は永久に直せなくなる。**
     *
     * **落ちた周回のぶんは、これまでどおり `alive` の窓が拾う**ので、
     * **#237 が拒んだ「自動で返す仕組み」とは別のもの**である。
     */
    it("持ち主が返せば、別の作業場が取れる", () => {
      withGh({ labels: [] });
      startRound(repo);
      expect(run(["pr", "42"]).status, "取れていない").toBe(0);

      expect(run(["release", "42"]).status, "返せていない").toBe(0);

      // **周回を回したままでも、返したぶんは空く**（`alive` の窓を待たない）
      expect(run(["pr", "42"], { cwd: addWorkspace("next") }).status, "空いていない").toBe(0);
    });

    it("返したら、自分のものではなくなる", () => {
      // **数える側（ステップ 2.1）が見るのは `mine`** である
      withGh({ labels: [] });
      startRound(repo);
      run(["pr", "42"]);

      run(["release", "42"]);

      expect(run(["mine", "42"]).status, "返したのに自分のものになっている").toBe(1);
    });

    it("別の作業場の claim は返せない", () => {
      // **返せるのは自分のものだけ。** **他人のものを消せると、排他が意味を失う**
      withGh({ labels: [] });
      startRound(repo);
      run(["pr", "42"]);

      const other = run(["release", "42"], { cwd: addWorkspace("stranger") });

      expect(other.status, "他人の claim を消している").toBe(1);
      expect(run(["mine", "42"]).status, "持ち主が変わっている").toBe(0);
    });

    it("記録が無ければ、何もせず終わる", () => {
      // **返す先が無いのは失敗ではない**（**取る前に返しても、周回は止まらない**）
      withGh({ labels: [] });

      expect(run(["release", "42"]).status).toBe(0);
    });
  });

  describe("release-issue — 自分が取った Issue の claim を返す", () => {
    /**
     * **取る口があって、返す口が無かった**（#460）。
     *
     * **`release` は PR 専用**で、**`take` / `resume` で取った Issue の記録は
     * 取った作業場のまま残る**——**取り違えたときの逃げ道が無い**（#306 が PR に
     * ついて直したのと同じ形）。**2026-08-24 に実際に踏んだ**（**#454 を引き継いで
     * 二重に実装し、PR は返せたが Issue の記録は返せなかった**）。
     */
    function startRound(cwd: string): string {
      const result = spawnSync(LEASE, ["acquire", "worker", workerStamp()], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, PATH: path },
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    }

    /** その Issue の claim の記録。**PR のぶんとは置き場が違う。** */
    function issueRecord(number: number): string {
      return join(repo, ".git", `valence-loop-claim-${number}`);
    }

    it("返したら、記録が残らない", () => {
      withGh({ labels: ["ready"] });
      startRound(repo);
      expect(run(["take", "42"]).status, "取れていない").toBe(0);

      expect(run(["release-issue", "42"]).status, "返せていない").toBe(0);

      expect(existsSync(issueRecord(42)), "返したのに記録が残っている").toBe(false);
    });

    it("返せば、別の作業場が続きを取れる", () => {
      // **周回を回したままでも空く**（`alive` の窓を待たない。`release` と同じ）
      withGh({ labels: ["ready"] });
      startRound(repo);
      run(["take", "42"]);

      run(["release-issue", "42"]);

      const other = run(["resume", "42"], { cwd: addWorkspace("次の作業場") });
      expect(other.status, "空いていない").toBe(0);
      expect(other.stderr, "引き継ぎとして扱っている（空いているはず）").not.toContain(
        "引き継ぎます",
      );
    });

    it("別の作業場の claim は返せない", () => {
      // **返せるのは自分のものだけ**（`release` と同じ扱い）
      withGh({ labels: ["ready"] });
      startRound(repo);
      run(["take", "42"]);

      const other = run(["release-issue", "42"], { cwd: addWorkspace("よその作業場") });

      expect(other.status, "他人の claim を消している").toBe(1);
      expect(existsSync(issueRecord(42)), "他人の記録を消している").toBe(true);
    });

    it("記録が無ければ、何もせず終わる", () => {
      // **返す先が無いのは失敗ではない**（`release` と同じ）
      withGh({ labels: [] });

      expect(run(["release-issue", "42"]).status).toBe(0);
    });

    it("同じ番号の PR と Issue を、取り違えない", () => {
      // **番号だけでは見分けられない**（#460。**同じ番号空間**）——**両方の記録が
      // 同時に在りうる**ので、**呼ぶ側に言わせている。** **片方を返したときに
      // もう片方が消えると、返した覚えのない claim が消える。**
      withGh({ labels: ["ready"] });
      startRound(repo);
      run(["take", "42"]);
      run(["pr", "42"]);

      expect(run(["release-issue", "42"]).status).toBe(0);

      expect(existsSync(issueRecord(42)), "Issue のぶんが返っていない").toBe(false);
      expect(run(["mine", "42"]).status, "PR のぶんまで返している").toBe(0);
    });

    it("PR の `release` は、Issue の記録を触らない", () => {
      // **逆向きも見る**（#460）——**書式の両方向**と同じ形である
      withGh({ labels: ["ready"] });
      startRound(repo);
      run(["take", "42"]);
      run(["pr", "42"]);

      expect(run(["release", "42"]).status).toBe(0);

      expect(run(["mine", "42"]).status, "PR のぶんが返っていない").toBe(1);
      expect(existsSync(issueRecord(42)), "Issue のぶんまで返している").toBe(true);
    });
  });

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

  describe("idle — 着手したまま実装が出ていない Issue を並べる", () => {
    /**
     * 着手中の Issue と、open PR が閉じる予定の Issue を返す偽の `gh`。
     *
     * **`--jq` の後ろの形で返す。** `audit` の偽物と同じ約束である
     * （**本物の `gh` が絞ったあとの行**を、そのまま出す）。
     */
    /**
     * **いま直接読んだら返る label** を、Issue ごとに置く。
     *
     * **一覧と直読みは、別のものを返しうる**（索引は遅れる）。**既定では揃えて置き**、
     * **`nowLabels` を渡した分だけ食い違わせる。**
     */
    function writeLabelFixtures(options: {
      inProgress?: { number: number; labels?: string[] }[];
      nowLabels?: Record<number, string[]>;
    }): string {
      const labelsDir = join(repo, "labels-idle");
      mkdirSync(labelsDir, { recursive: true });
      for (const issue of options.inProgress ?? []) {
        const now = options.nowLabels?.[issue.number] ?? issue.labels ?? ["in-progress"];
        writeFileSync(join(labelsDir, String(issue.number)), `${now.join("\n")}\n`);
      }
      return labelsDir;
    }

    /**
     * **その Issue を「言及している」open PR** を、Issue ごとに置く。
     *
     * **言及と実装は別である** (#322 のレビュー 2 周目)。**このループは番号を引き合いに
     * 出しながら書く**ので、**参照だけで黙る実装に戻したら、この口が答えた瞬間に赤くなる。**
     */
    function writeReferenceFixtures(referencedBy: Record<number, number[]> | undefined): string {
      const refsDir = join(repo, "refs-idle");
      mkdirSync(refsDir, { recursive: true });
      for (const [number, prs] of Object.entries(referencedBy ?? {})) {
        writeFileSync(join(refsDir, number), `${prs.join("\n")}\n`);
      }
      return refsDir;
    }

    function withIdle(options: {
      inProgress?: { number: number; labels?: string[] }[];
      /**
       * open PR。**`closes` は閉じる予定の Issue**（**別リポジトリのものも置ける**）、
       * **`head` は枝の名前**である。
       */
      prs?: { closes?: number[]; repo?: string; head?: string }[];
      /**
       * **いま直接読んだら返る label。** 省くと一覧と同じものが返る。
       *
       * **索引（`issue list`）は遅れる**ので、**一覧に居るのに、いまは着手中でない**
       * という状態が実在する（マージ直後がいちばん踏みやすい）。
       */
      nowLabels?: Record<number, string[]>;
      /**
       * その Issue を**言及している** open PR の番号。
       *
       * **言及は実装ではない** (#322 のレビュー 2 周目)——**「#312 と同じ形」と
       * 書いただけの PR も `CROSS_REFERENCED_EVENT` になる。**
       */
      referencedBy?: Record<number, number[]>;
      /**
       * この一覧だけが読めない。**「0 件」と読み違えないこと**を見る。
       *
       * **全部の `gh` を落とさない。** **手前の呼び出しで止まると、
       * 見たかった経路まで届かない**（届いていないのに緑になる）。
       */
      failOn?: "issue list" | "pr list" | "issue view" | "number,title";
      /**
       * **入った子 PR**（#512）。**枝の名前と、入った時刻**である。
       *
       * **親 Issue は子 PR で閉じない**（`Closes` を書かない。#321）ので、
       * **open な子が無い谷では、動いている証拠が一切見えなくなる。**
       */
      mergedPrs?: { head: string; mergedAt: string }[];
      /**
       * **Issue のタイトル**（#544）。**親子の繋がりは、ここの末尾で決まる。**
       *
       * **子 Issue を立てて割ると、親の番号を持つ枝が 1 本も出ない**
       * ——**`feat/542-...` が名乗るのは子の番号**である。
       */
      titles?: Record<number, string>;
    }): void {
      const issues = (options.inProgress ?? [])
        .map((issue) => `${issue.number}\t${(issue.labels ?? ["in-progress"]).join(",")}`)
        .join("\n");
      // **1 回の `pr list` が返す行。** **枝と `Closes` を種別で書き分ける**
      const openPrs = (options.prs ?? [])
        .flatMap((pr) => [
          ...(pr.head === undefined ? [] : [`head\t${pr.head}`]),
          ...(pr.closes ?? []).map((number) => `closes\t${pr.repo ?? "owner/repo"}\t${number}`),
        ])
        .join("\n");
      // **入った PR は別の一覧で返る**（`--state merged`）——**open の一覧と混ぜない**
      const mergedPrs = (options.mergedPrs ?? [])
        .map((pr) => `${pr.head}\t${pr.mergedAt}`)
        .join("\n");
      // **タイトルの一覧は、着手中の一覧とは別の呼び方で来る**（`--json number,title`）
      const titles = Object.entries(options.titles ?? {})
        .map(([number, title]) => `${number}\t${title}`)
        .join("\n");
      const labelsDir = writeLabelFixtures(options);
      const refsDir = writeReferenceFixtures(options.referencedBy);

      writeFileSync(
        join(path, "gh"),
        [
          "#!/usr/bin/env bash",
          `labels_dir=${JSON.stringify(labelsDir)}`,
          `refs_dir=${JSON.stringify(refsDir)}`,
          ...(options.failOn === undefined
            ? []
            : [`if [[ $* == *${JSON.stringify(options.failOn)}* ]]; then exit 1; fi`]),
          'if [[ $* == *"repo view"* ]]; then',
          '  echo "owner"',
          '  echo "repo"',
          "  exit 0",
          "fi",
          // **タイトルの一覧**（#544）——**着手中の一覧より先に見る**
          // （**どちらも `issue list` で来る**）
          'if [[ $* == *"issue list"* && $* == *"number,title"* ]]; then',
          `  printf '%b' ${JSON.stringify(titles)}`,
          `  [[ -n ${JSON.stringify(titles)} ]] && echo`,
          "  exit 0",
          "fi",
          'if [[ $* == *"issue list"* ]]; then',
          `  printf '%b' ${JSON.stringify(issues)}`,
          `  [[ -n ${JSON.stringify(issues)} ]] && echo`,
          "  exit 0",
          "fi",
          'if [[ $* == *"--state merged"* ]]; then',
          // **何で絞って訊いたかを残す**（#514 のレビュー）——**並びに頼っていないこと**
          // **を、呼び方から見る**
          `  printf '%s\\n' "$*" >>${JSON.stringify(join(repo, "merged-query"))}`,
          `  printf '%b' ${JSON.stringify(mergedPrs)}`,
          `  [[ -n ${JSON.stringify(mergedPrs)} ]] && echo`,
          "  exit 0",
          "fi",
          'if [[ $* == *"pr list"* ]]; then',
          `  printf '%b' ${JSON.stringify(openPrs)}`,
          `  [[ -n ${JSON.stringify(openPrs)} ]] && echo`,
          "  exit 0",
          "fi",
          // **その Issue を言及している open PR**。**番号は `-F number=<N>` で来る**
          //
          // **答える口は残してある**（#322 のレビュー 2 周目）——**言及で黙る実装に
          // 戻したら、ここが答えた瞬間に「言及しただけでは黙らない」が赤くなる。**
          'if [[ $* == *"api graphql"* ]]; then',
          "  for word in $*; do",
          "    [[ $word == number=* ]] || continue",
          '    issue="${word#number=}"',
          '    [[ -f "$refs_dir/$issue" ]] && cat "$refs_dir/$issue"',
          "    exit 0",
          "  done",
          "  exit 0",
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

    const NOW = Math.floor(Date.now() / 1000);

    /** 記録を置く。**`taken` を省くと、前の書式（1 行だけ）になる。** */
    function writeClaim(
      number: number,
      options: { touched: number; taken?: number; owner?: string },
    ): void {
      const head = `${options.owner ?? repo}\t${options.touched}\n`;
      const tail = options.taken === undefined ? "" : `${options.taken}\n`;
      writeFileSync(join(repo, ".git", `valence-loop-claim-${number}`), `${head}${tail}`);
    }

    function claimLines(number: number): string[] {
      return readFileSync(join(repo, ".git", `valence-loop-claim-${number}`), "utf8")
        .trimEnd()
        .split("\n");
    }

    it("着手から長く経っても実装が出ていない Issue を並べる", () => {
      withIdle({ inProgress: [{ number: 264 }] });
      writeClaim(264, { touched: NOW, taken: NOW - 9000 });

      const idle = run(["idle"]);

      expect(idle.status).toBe(0);
      // **種別を出す。** **「実装が出ていない」と「測れない」は原因が違う**ので、
      // **積む識別子も違う**——**呼ぶ側が読み分けられる形で返す**
      // **秒数は進む。** **時刻そのものを固定できる場所ではない**ので、
      // **種別と番号を突き合わせ、経過は「閾値を超えている」だけを見る**
      const [kind, number, elapsed] = (idle.stdout.split("\n")[0] ?? "").split("\t");
      expect([kind, number]).toEqual(["stalled", "264"]);
      expect(Number(elapsed)).toBeGreaterThanOrEqual(9000);
    });

    it("子 PR が最近入っていれば、親を止まっていると言わない", () => {
      // **親として残した Issue は、子 PR と子 PR のあいだで必ず「実装が出ていない」に
      // 倒れる** (#512)。**時計は `take` のときのまま**で、**open な子が無い瞬間**は
      // **谷の長さに関係なく鳴る**——**実測では、直前の子が入った 75 秒後に鳴った。**
      const iso = (secondsAgo: number): string =>
        new Date((NOW - secondsAgo) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
      withIdle({
        inProgress: [{ number: 506 }],
        mergedPrs: [{ head: "fix/506-redirect-to-opened-origin", mergedAt: iso(600) }],
      });
      writeClaim(506, { touched: NOW, taken: NOW - 9000 });

      expect(run(["idle"]).status, "入ったばかりの子 PR があるのに、止まっていると言う").toBe(1);
    });

    /**
     * **子 Issue を立てて割ると、親の番号を持つ枝が 1 本も出ない**（#544）。
     *
     * **割り方は 2 通りある。** **親の番号のまま割る**（#512 が塞いだ形）と、
     * **子 Issue を立ててから割る**（手順が勧めている形）——**後者では、枝が名乗るのは
     * 子の番号**である。**親の時計は `take` のときのまま**なので、
     * **`IDLE_SEC` を過ぎたら必ず鳴る。**
     *
     * **入力は実データの形である**——**親 #540 / 子 #542 / 枝 `feat/542-...`。**
     */
    describe("子 Issue を立てて割った親", () => {
      const iso = (secondsAgo: number): string =>
        new Date((NOW - secondsAgo) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

      it("子 Issue の open PR があれば、親を止まっていると言わない", () => {
        withIdle({
          inProgress: [{ number: 540 }, { number: 542 }],
          prs: [{ head: "feat/542-title-in-the-box" }],
          titles: { 542: "図の箱に、PR のタイトルを出す（#540）" },
        });
        writeClaim(540, { touched: NOW, taken: NOW - 30000 });
        writeClaim(542, { touched: NOW, taken: NOW - 600 });

        expect(
          run(["idle"]).stdout,
          "子 Issue の実装が出ているのに、親を止まっていると言う",
        ).not.toMatch(/^stalled\t540\t/m);
      });

      it("子 Issue の PR が最近入っていれば、親を止まっていると言わない", () => {
        withIdle({
          inProgress: [{ number: 540 }],
          mergedPrs: [{ head: "feat/542-title-in-the-box", mergedAt: iso(600) }],
          titles: { 542: "図の箱に、PR のタイトルを出す（#540）" },
        });
        writeClaim(540, { touched: NOW, taken: NOW - 30000 });

        expect(run(["idle"]).status, "子 Issue の PR が入ったばかりなのに鳴る").toBe(1);
      });

      it("子 Issue の PR が入ってから長く経てば、これまでどおり並べる", () => {
        // **谷を許すのは「動いているあいだ」だけ**である——**子が全部片付いて、
        // 親に残った仕事を誰も拾っていない**なら、**人が要る。**
        withIdle({
          inProgress: [{ number: 540 }],
          mergedPrs: [{ head: "feat/542-title-in-the-box", mergedAt: iso(20000) }],
          titles: { 542: "図の箱に、PR のタイトルを出す（#540）" },
        });
        writeClaim(540, { touched: NOW, taken: NOW - 30000 });

        expect(run(["idle"]).stdout.split("\n")[0], "止まっているのに黙っている").toMatch(
          /^stalled\t540\t/,
        );
      });

      it("別の親の子 Issue では、黙らない", () => {
        withIdle({
          inProgress: [{ number: 540 }],
          prs: [{ head: "feat/542-title-in-the-box" }],
          titles: { 542: "何か別のこと（#999）" },
        });
        writeClaim(540, { touched: NOW, taken: NOW - 30000 });

        expect(run(["idle"]).stdout.split("\n")[0], "別の親の子で黙っている").toMatch(
          /^stalled\t540\t/,
        );
      });

      it("タイトルの途中で番号に触れただけでは、黙らない", () => {
        // **#322 の前に戻さない**——**このリポジトリは番号を引き合いに出しながら書く**ので、
        // **「言及したら黙る」に戻すと、開いている PR がある限りその Issue では黙る。**
        // **見るのは末尾だけ**である。
        withIdle({
          inProgress: [{ number: 540 }],
          prs: [{ head: "feat/542-title-in-the-box" }],
          titles: { 542: "#540 と同じ形を、別のところで直す" },
        });
        writeClaim(540, { touched: NOW, taken: NOW - 30000 });

        expect(run(["idle"]).stdout.split("\n")[0], "言及しただけで黙っている").toMatch(
          /^stalled\t540\t/,
        );
      });

      it("孫 Issue の PR でも、親を止まっていると言わない", () => {
        // **割った先を、さらに割ってよい**（起票の規則）——**1 段だけ辿ると、
        // 孫の枝で動いている親が「止まっている」に倒れる。**
        withIdle({
          inProgress: [{ number: 540 }],
          prs: [{ head: "feat/546-even-smaller" }],
          titles: {
            542: "図の箱に、PR のタイトルを出す（#540）",
            546: "そのうちの 1 つだけ先に（#542）",
          },
        });
        writeClaim(540, { touched: NOW, taken: NOW - 30000 });

        expect(run(["idle"]).stdout, "孫の実装が出ているのに、親を止まっていると言う").not.toMatch(
          /^stalled\t540\t/m,
        );
      });

      it("親子が輪になっていても、止まらずに答える", () => {
        // **タイトルは人が書く**ので、**A の子が B、B の子が A** は実在しうる
        // ——**辿り続けると、この検出器がその周回ごと止まる**（**黙るより悪い**）。
        withIdle({
          inProgress: [{ number: 540 }],
          prs: [{ head: "feat/546-even-smaller" }],
          titles: { 546: "あれの続き（#547）", 547: "これの続き（#546）" },
        });
        writeClaim(540, { touched: NOW, taken: NOW - 30000 });

        expect(run(["idle"]).stdout.split("\n")[0], "輪の中で黙っている").toMatch(
          /^stalled\t540\t/,
        );
      });

      it("自分を親と書いた Issue でも、止まらずに答える", () => {
        withIdle({
          inProgress: [{ number: 540 }],
          prs: [{ head: "feat/546-even-smaller" }],
          titles: { 546: "自分の続き（#546）" },
        });
        writeClaim(540, { touched: NOW, taken: NOW - 30000 });

        expect(run(["idle"]).stdout.split("\n")[0], "自分を指す輪で黙っている").toMatch(
          /^stalled\t540\t/,
        );
      });

      it("末尾でない（#N）では、黙らない", () => {
        // **見るのは末尾だけ**である——**途中に置かれた番号は、引き合いに出しただけ**
        // かもしれない。**錨を外すと、`（#540）の続き` まで子として数える。**
        withIdle({
          inProgress: [{ number: 540 }],
          prs: [{ head: "feat/542-title-in-the-box" }],
          titles: { 542: "（#540）の続きで、別のところを直す" },
        });
        writeClaim(540, { touched: NOW, taken: NOW - 30000 });

        expect(run(["idle"]).stdout.split("\n")[0], "末尾でない番号で黙っている").toMatch(
          /^stalled\t540\t/,
        );
      });

      it("括弧の中に語があるものは、親子に数えない", () => {
        // **末尾の `（#N …）` は親子とは限らない**（#545 のレビュー）——
        // **`（#82 の前提）` は「#82 がこれを待つ」**であって、**「これが #82 の一部」
        // ではない。** **括弧の中を読み分けずに数えると、向きの逆な PR が親を黙らせる**
        // （#322 の向き）。
        withIdle({
          inProgress: [{ number: 540 }],
          prs: [{ head: "feat/546-even-smaller" }],
          titles: { 546: "その続き（#540 の続き）" },
        });
        writeClaim(540, { touched: NOW, taken: NOW - 30000 });

        expect(run(["idle"]).stdout.split("\n")[0], "括弧の中に語があるのに数えている").toMatch(
          /^stalled\t540\t/,
        );
      });

      it("数えなかった惜しい書き方を、鳴らすときに言う", () => {
        // **このリポジトリは実際にその形を書いている**（**末尾が `（#N …）` の Issue は
        // 38 件、うち厳密に `（#N）` は 3 件**。master が数えた）——**書いた人は
        // 「末尾に置いた」と思っている。** **数えていないことを言わないと、
        // 呼ばれた人は「なぜ鳴ったか」に辿り着けない。**
        withIdle({
          inProgress: [{ number: 540 }],
          prs: [{ head: "feat/546-even-smaller" }],
          titles: { 546: "その続き（#540 の続き）" },
        });
        writeClaim(540, { touched: NOW, taken: NOW - 30000 });

        expect(run(["idle"]).stderr, "数えなかったことを黙っている").toMatch(
          /#546 のタイトルは（#540 …）で終わっていますが/,
        );
      });

      it("鎖の途中が惜しい形なら、その途中を名指しで言う", () => {
        // **枝自身が厳密でも、鎖の途中が惜しい形なら親には届かない**（#545 のレビュー
        // 2 周目）——**38 件中 35 件が惜しい形**なので、**途中が惜しいほうが普通である。**
        //
        // **「同じ形が 1 段深いところで再発する」**は、孫の対応で書いた言葉である
        // ——**その対応の中でもう 1 度起きていた。**
        withIdle({
          inProgress: [{ number: 540 }],
          prs: [{ head: "feat/546-even-smaller" }],
          titles: { 546: "そのうちの 1 つ（#542）", 542: "図の箱の続き（#540 の続き）" },
        });
        writeClaim(540, { touched: NOW, taken: NOW - 30000 });

        const idle = run(["idle"]);

        expect(idle.stdout.split("\n")[0], "鎖が切れているのに黙っている").toMatch(
          /^stalled\t540\t/,
        );
        // **切れているのは #542 と #540 のあいだ**である——**#546 を名指ししない**
        expect(idle.stderr, "どこで切れたかを言っていない").toMatch(
          /#542 のタイトルは（#540 …）で終わっていますが/,
        );
        expect(idle.stderr, "厳密に書いてある #546 を名指ししている").not.toMatch(
          /#546 のタイトルは/,
        );
      });

      it("切れ目が 2 つあるなら、枝に近いほうを言う", () => {
        // **直しに行くのは、枝から辿って最初に切れているところ**である
        // ——**そこを直せば、次の切れ目まで鎖が伸びる。**
        withIdle({
          inProgress: [{ number: 540 }],
          prs: [{ head: "feat/548-smallest" }],
          titles: {
            548: "さらに小さく（#546 の続き）",
            546: "そのうちの 1 つ（#542 の続き）",
            542: "図の箱の続き（#540）",
          },
        });
        writeClaim(540, { touched: NOW, taken: NOW - 30000 });

        const idle = run(["idle"]);

        expect(idle.stderr, "枝に近い切れ目を言っていない").toMatch(/#548 のタイトルは/);
        expect(idle.stderr, "切れ目を 2 つとも並べている").not.toMatch(/#546 のタイトルは/);
      });

      it("同じ切れ目を、枝の数だけ繰り返さない", () => {
        // **毎回同じ行が並ぶと読まれなくなる** (#248)
        withIdle({
          inProgress: [{ number: 540 }],
          prs: [{ head: "feat/546-one" }, { head: "feat/547-another" }],
          titles: {
            546: "ひとつめ（#542）",
            547: "ふたつめ（#542）",
            542: "図の箱の続き（#540 の続き）",
          },
        });
        writeClaim(540, { touched: NOW, taken: NOW - 30000 });

        const said = run(["idle"])
          .stderr.split("\n")
          .filter((line) => line.includes("#542 のタイトルは"));

        expect(said, "同じ切れ目を繰り返している").toHaveLength(1);
      });

      it("厳密に書いてあるときは、余計なことを言わない", () => {
        // **平常時に鳴る検査は読まれなくなる** (#248)
        withIdle({
          inProgress: [{ number: 540 }],
          mergedPrs: [{ head: "feat/542-title-in-the-box", mergedAt: iso(20000) }],
          titles: { 542: "図の箱に、PR のタイトルを出す（#540）" },
        });
        writeClaim(540, { touched: NOW, taken: NOW - 30000 });

        expect(run(["idle"]).stderr, "数えたものについて言っている").not.toMatch(
          /括弧の中に語があるので/,
        );
      });

      it("別の親の惜しい書き方では、言わない", () => {
        // **鳴っている当の Issue のことだけを言う**——**関係ない行を足すと読まれなくなる**
        withIdle({
          inProgress: [{ number: 540 }],
          prs: [{ head: "feat/546-even-smaller" }],
          titles: { 546: "その続き（#999 の続き）" },
        });
        writeClaim(540, { touched: NOW, taken: NOW - 30000 });

        expect(run(["idle"]).stderr, "別の親のことを言っている").not.toMatch(/#546 のタイトル/);
      });

      it("上限まで読んだら、見落としえることを言う", () => {
        // **落ちた行は「無かったこと」になる** (#537)——**黙って切ると、鳴った理由が
        // 「子を見落としたから」だと分からない。** **窓を上限まで埋めて測る**
        // ——**埋めないと切り落としは起きない。**
        const many: Record<number, string> = {};
        for (let index = 0; index < 500; index += 1) {
          many[1000 + index] = `何か（#${9000 + index}）`;
        }
        withIdle({
          inProgress: [{ number: 540 }],
          prs: [{ head: "feat/542-title-in-the-box" }],
          titles: many,
        });
        writeClaim(540, { touched: NOW, taken: NOW - 30000 });

        expect(run(["idle"]).stderr, "上限まで読んだことを黙っている").toMatch(
          /500 件までしか読んでいません/,
        );
      });

      it("上限に届かなければ、余計なことを言わない", () => {
        // **平常時に鳴る検査は読まれなくなる** (#248)
        withIdle({
          inProgress: [{ number: 540 }],
          prs: [{ head: "feat/542-title-in-the-box" }],
          titles: { 542: "図の箱に、PR のタイトルを出す（#540）" },
        });
        writeClaim(540, { touched: NOW, taken: NOW - 30000 });

        expect(run(["idle"]).stderr, "届いていないのに言っている").not.toMatch(
          /までしか読んでいません/,
        );
      });

      it("タイトルの一覧を読めなければ、判定できないと言う", () => {
        // **読めないものを「動いている」に倒すと、この検出器だけが静かに消える**
        withIdle({
          inProgress: [{ number: 540 }],
          prs: [{ head: "feat/542-title-in-the-box" }],
          titles: {},
          failOn: "number,title",
        });
        writeClaim(540, { touched: NOW, taken: NOW - 30000 });

        expect(run(["idle"]).status, "読めないまま答えている").toBe(2);
      });
    });

    it("入った子 PR は、入った時刻で絞って訊く", () => {
      // **`gh pr list` が返すのは「作られた順」**である (#514 のレビュー。**実データで
      // 入った順と食い違う**)——**件数で切ると、落ちるのは「そのあとに 100 本
      // 作られた PR」**で、**長く置かれた枝ほど落ちやすい**（`parked` は日をまたぐ）。
      //
      // **並びに頼らない**——**窓は query の側で決める。**
      withIdle({ inProgress: [{ number: 506 }] });
      writeClaim(506, { touched: NOW, taken: NOW - 9000 });

      run(["idle"]);

      const asked = readFileSync(join(repo, "merged-query"), "utf8");
      expect(asked, "入った時刻で絞らずに訊いている").toMatch(/merged:>=\d{4}-\d{2}-\d{2}T/);
    });

    it("子 PR が入ってから長く経てば、これまでどおり並べる", () => {
      // **谷を許すぶん、止まった判定は遅れる**（**その代わり、動いている間は鳴らない**）
      // ——**「本当に止まったときは倒れる」**が消えていないことを見る。
      const iso = (secondsAgo: number): string =>
        new Date((NOW - secondsAgo) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
      withIdle({
        inProgress: [{ number: 506 }],
        mergedPrs: [{ head: "fix/506-redirect-to-opened-origin", mergedAt: iso(20000) }],
      });
      writeClaim(506, { touched: NOW, taken: NOW - 30000 });

      expect(run(["idle"]).stdout.split("\n")[0], "止まっているのに黙っている").toMatch(
        /^stalled\t506\t/,
      );
    });

    it("別の Issue の子 PR が入っても、黙らない", () => {
      // **枝の番号で見る** (#322)——**他所の番号で黙ると、この検出器が消える**
      const iso = (secondsAgo: number): string =>
        new Date((NOW - secondsAgo) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
      withIdle({
        inProgress: [{ number: 506 }],
        mergedPrs: [{ head: "fix/999-something-else", mergedAt: iso(60) }],
      });
      writeClaim(506, { touched: NOW, taken: NOW - 9000 });

      expect(run(["idle"]).stdout.split("\n")[0], "別の Issue の枝で黙っている").toMatch(
        /^stalled\t506\t/,
      );
    });

    it("入った時刻を読めない子 PR は、動いている証拠に数えない", () => {
      // **読めないものを「動いている」に倒すと、この検出器だけが静かに消える**
      // （**番号を読めない枝を、実装が出ていない側へ倒すのと同じ向き**）。
      // **黙らずに言う**——**読めなかったことは、行として残す。**
      withIdle({
        inProgress: [{ number: 506 }],
        mergedPrs: [{ head: "fix/506-redirect-to-opened-origin", mergedAt: "いつか" }],
      });
      writeClaim(506, { touched: NOW, taken: NOW - 9000 });

      const idle = run(["idle"]);

      expect(idle.stdout.split("\n")[0], "読めない時刻で黙っている").toMatch(/^stalled\t506\t/);
      expect(idle.stderr, "読めなかったことを黙っている").toMatch(/入った時刻を読めません/);
    });

    it("`Closes` が無くても、実装が出ていれば並べない", () => {
      // **割った PR は親 Issue を閉じない**（**途中の 1/3 に `Closes` を書くと、
      // そこが入った時点で親が閉じる**）ので、**`closingIssuesReferences` には出てこない**
      // ——**`Closes` だけを見ていると、実装が出ているのに「出ていない」と報告する**（#321）。
      //
      // **人が呼ばれる理由が変わる**のが悪い：**実際は人の判断待ち**なのに、
      // **「実装が出ていない」と書いて呼ぶ**——**来た人は違う場所を見る。**
      withIdle({
        inProgress: [{ number: 315 }],
        prs: [{ head: "feat/315-approve-pull-request" }],
      });
      writeClaim(315, { touched: NOW, taken: NOW - 9000 });

      expect(run(["idle"]).status, "実装が出ているのに stalled と報告している").toBe(1);
    });

    it("言及しただけの open PR では黙らない", () => {
      // **「#312 と同じ形」と書けば、それは #312 への `CROSS_REFERENCED_EVENT` になる**
      // ——**このループは番号を引き合いに出しながら書く**ので、**参照で数えると
      // 「開いている PR がある限り黙る」**（#322 のレビュー 2 周目）。
      //
      // **入れる前より悪い向きである。** **誤報は行が見えるが、黙るのは見えない**
      // ——**本当に止まっても、誰も呼ばれない。**
      withIdle({
        inProgress: [{ number: 315 }],
        prs: [{ head: "fix/321-idle-cross-references" }],
        referencedBy: { 315: [322] },
      });
      writeClaim(315, { touched: NOW, taken: NOW - 9000 });

      expect(run(["idle"]).stdout.split("\n")[0], "言及しただけの PR で黙っている").toMatch(
        /^stalled\t315\t/,
      );
    });

    it("実装の枝が 1 本も無ければ、これまでどおり並べる", () => {
      // **緩めすぎない側の担保。** **実装を探しに行くようにしたせいで、
      // 本物の停止まで見逃したら、この検出器そのものが死ぬ**
      withIdle({ inProgress: [{ number: 264 }], prs: [{ head: "fix/321-other" }] });
      writeClaim(264, { touched: NOW, taken: NOW - 9000 });

      expect(run(["idle"]).status).toBe(0);
      expect(run(["idle"]).stdout.split("\n")[0]).toMatch(/^stalled\t264\t/);
    });

    it("番号が前に付いているだけの枝は、その Issue の実装ではない", () => {
      // **`feat/3150-` は #315 ではない。** **前方一致で数えると、番号が長い Issue の
      // 実装が、短い番号の Issue を黙らせる**
      withIdle({ inProgress: [{ number: 315 }], prs: [{ head: "feat/3150-something" }] });
      writeClaim(315, { touched: NOW, taken: NOW - 9000 });

      expect(run(["idle"]).stdout.split("\n")[0], "別の Issue の枝で黙っている").toMatch(
        /^stalled\t315\t/,
      );
    });

    it("番号を読めない枝は、実装が出ていない側へ倒す", () => {
      // **積みすぎても人が呼ばれるだけ**だが、**積み損ねると誰も来ない**
      // ——**規約から外れた枝は、黙る理由にしない**
      withIdle({ inProgress: [{ number: 315 }], prs: [{ head: "feat/approve-pull-request" }] });
      writeClaim(315, { touched: NOW, taken: NOW - 9000 });

      expect(run(["idle"]).stdout.split("\n")[0], "番号の無い枝で黙っている").toMatch(
        /^stalled\t315\t/,
      );
    });

    it("着手して間もない Issue は並べない", () => {
      // **実装には複数の周回がかかる。** 短くすると、健全な作業が止まる
      withIdle({ inProgress: [{ number: 264 }] });
      writeClaim(264, { touched: NOW, taken: NOW - 60 });

      expect(run(["idle"]).status).toBe(1);
    });

    it("閉じる open PR があれば並べない", () => {
      // **実装は出ている。** そこから先はレビューの側で数える（`awaiting-worker`）
      withIdle({ inProgress: [{ number: 264 }], prs: [{ closes: [264] }] });
      writeClaim(264, { touched: NOW, taken: NOW - 9000 });

      expect(run(["idle"]).status).toBe(1);
    });

    it("別のリポジトリの同じ番号を閉じる PR は、実装ではない", () => {
      withIdle({
        inProgress: [{ number: 264 }],
        prs: [{ closes: [264], repo: "other/repo" }],
      });
      writeClaim(264, { touched: NOW, taken: NOW - 9000 });

      expect(run(["idle"]).status).toBe(0);
    });

    it("blocked が付いていれば並べない", () => {
      // **人の判断待ちである。** 手が止まっているのは正しい状態で、数えると
      // **人が来るまで毎周回積み続ける**
      withIdle({ inProgress: [{ number: 264, labels: ["in-progress", "blocked"] }] });
      writeClaim(264, { touched: NOW, taken: NOW - 9000 });

      expect(run(["idle"]).status).toBe(1);
    });

    it("再開しても、着手した時刻は書き直さない", () => {
      // **これが本題。** **記録の時刻は周回のたびに新しくなる**ので、
      // **そのまま数えると「着手したまま出ていない」を永久に測れない**
      withIdle({ inProgress: [{ number: 264 }] });
      writeClaim(264, { touched: NOW - 9000, taken: NOW - 9000 });

      expect(run(["resume", "264"]).status).toBe(0);

      const resumed = claimLines(264);
      expect(Number(resumed[0]?.split("\t")[1]), "触った時刻は新しくなる").toBeGreaterThan(
        NOW - 60,
      );
      expect(run(["idle"]).status).toBe(0);
    });

    it("take は着手した時刻を、次の行に残す", () => {
      // **足す場所を決めたのがこの Issue である。** 残さなければ、どこにも測る値が無い
      withGh({ labels: ["ready"], viewDelay: "0" });

      expect(run(["take", "264"]).status).toBe(0);

      const lines = claimLines(264);
      // **1 行目を増やさない。** **記録は版をまたいで共有される**——**前の版は
      // `read` で 1 行目だけを読み、2 列目が数字でなければ「読めません」で
      // exit 2**（実測。#281 の周回が、自分で書いた記録を main の版で読めなかった）。
      // **止まるのは判定できないほうへ倒れた経路すべて**（`pr` / `resume` / `audit`）で、
      // **その PR が自分自身で詰む**（#262 と同じ形）。
      expect(lines[0]?.split("\t")).toHaveLength(2);
      expect(Number(lines[1])).toBeGreaterThan(NOW - 60);
    });

    it("前の書式で書かれた記録は、触った時刻から数える", () => {
      // **書式を変えたら、前の書式で書かれた入力を置く**（AGENTS.md §5）。
      // **記録はループを跨いで残る**ので、**古い形のまま次の周回が読む**
      withIdle({ inProgress: [{ number: 264 }] });
      writeClaim(264, { touched: NOW - 9000 });

      expect(run(["idle"]).status).toBe(0);

      // **新しいほうも置く。** **空を 0 として数えると、前の書式の記録が
      // すべて「1970 年から着手中」になり**、**取った直後の Issue まで並ぶ**
      writeClaim(264, { touched: NOW });

      expect(run(["idle"]).status).toBe(1);
    });

    it("着手中なのに記録が無い Issue を、健全と同じ出口にしない", () => {
      // **これが壊れた状態そのものである** (#281 のレビュー)。**`take` は label を
      // 先に付ける**ので、**その間に落ちれば「`in-progress` なのに記録が無い」**
      // ——**`write_record` が失敗した場合も同じ**。**この Issue が捕まえたい状態**である。
      //
      // **飛ばすと exit 1 になり、手順書は「無い」と読む**——**測れないことが、
      // 健全と同じ答えになる**（**この PR 自身が 2 度書いている原則に反する**）。
      //
      // **`stalled` と混ぜない。** **原因が違い、人が次にやることも違う**
      // （**尽きた worker を見る**のか、**持ち主のいない着手を戻す**のか）。
      withIdle({ inProgress: [{ number: 264 }] });

      const idle = run(["idle"]);

      expect(idle.status).toBe(0);
      expect(idle.stdout.split("\n")[0]).toBe(`unowned\t264`);
    });

    it("一覧が遅れていて、いまは着手中でないものを並べない", () => {
      // **索引は遅れる** (#281 のレビュー 2 周目)。**同じ出口で `audit` が先に走り、
      // 「着手中でない」と判断して記録を消す**——**その直後に一覧を読むと、
      // 消えた記録の Issue がまだ並ぶ**（**マージした周回がいちばん踏みやすい**）。
      //
      // **鳴るのは毎回のマージ**なので、**次に来た人はまず検出器を疑う**——
      // **偽陽性が「たまに」でなくなると、この仕組みは死ぬ。**
      withIdle({
        inProgress: [{ number: 264 }],
        nowLabels: { 264: [] }, // マージして label が外れた直後
      });
      writeClaim(264, { touched: NOW, taken: NOW - 9000 });

      expect(run(["idle"]).status).toBe(1);
    });

    it("一覧が遅れていて記録も無いものを、持ち主のいない着手にしない", () => {
      // **`unowned` の側も同じ**（**記録は `audit` が消し、一覧だけが残る**）
      withIdle({ inProgress: [{ number: 264 }], nowLabels: { 264: [] } });

      expect(run(["idle"]).status).toBe(1);
    });

    it("いま blocked が付いていれば、一覧が古くても並べない", () => {
      // **止められた直後も、索引は遅れる。** **`blocked` は人の判断待ち**なので、
      // **手が止まっているのが正しい状態**——**そこで鳴らすと、人が来るまで積み続ける**
      withIdle({
        inProgress: [{ number: 264 }],
        nowLabels: { 264: ["in-progress", "blocked"] },
      });
      writeClaim(264, { touched: NOW, taken: NOW - 9000 });

      expect(run(["idle"]).status).toBe(1);
    });

    it("label を読み直せなければ 2 で落ちる", () => {
      // **「着手中でない」へ倒さない。** 倒すと、**読めないあいだ検出器が黙る**
      withIdle({ inProgress: [{ number: 264 }], failOn: "issue view" });
      writeClaim(264, { touched: NOW, taken: NOW - 9000 });

      expect(run(["idle"]).status).toBe(2);
    });

    it("着手中の一覧を読めなければ 2 で落ちる", () => {
      // **「0 件」と読み違えない。** 読めないまま「動いている」と答えると、
      // **この検出器が黙って消える**（状態は健全に見えたままである）
      withIdle({ inProgress: [{ number: 264 }], failOn: "issue list" });
      writeClaim(264, { touched: NOW, taken: NOW - 9000 });

      expect(run(["idle"]).status).toBe(2);
    });

    it("open PR の一覧を読めなければ 2 で落ちる", () => {
      // **こちらを 0 件と読むと、逆へ倒れる**——**実装が出ているのに「出ていない」**と
      // 読み、**健全に進んでいる Issue で人を呼ぶ**
      withIdle({ inProgress: [{ number: 264 }], failOn: "pr list" });
      writeClaim(264, { touched: NOW, taken: NOW - 9000 });

      expect(run(["idle"]).status).toBe(2);
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
