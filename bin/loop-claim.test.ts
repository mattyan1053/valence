import { spawn, spawnSync } from "node:child_process";
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

const SCRIPT = fileURLToPath(new URL("./loop-claim", import.meta.url));

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

  function editCount(): number {
    return readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line === "edit").length;
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "loop-claim-"));
    expect(spawnSync("git", ["init", "--quiet", repo]).status).toBe(0);
    // 作業場を足すには commit が 1 つ要る
    expect(
      spawnSync("git", ["-C", repo, "commit", "--allow-empty", "--quiet", "-m", "init"], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@e",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@e",
        },
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
      "grep",
      "printf",
    ]) {
      const found = spawnSync("which", [command], { encoding: "utf8" }).stdout.trim();
      if (found !== "") {
        symlinkSync(found, join(path, command));
      }
    }
    chmodSync(path, 0o755);
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

  describe("audit — label と実態の食い違いを見つける", () => {
    /** open PR の本文と、Issue ごとの label を返す偽の `gh`。 */
    function withAudit(options: {
      /** **本文は渡さない。** `Closes` の書き方を自分で解析しない（GitHub に訊く）。 */
      prs?: { number: number; closes: number[] }[];
      labelsOf?: Record<number, string[]>;
      /** label の付け替えが失敗する。**部分的に成功した状態を作らせない**ための試験。 */
      editFails?: boolean;
    }): void {
      const prs = (options.prs ?? []).map((pr) => String(pr.number)).join("\n");
      const closesOf = (options.prs ?? [])
        .map(
          (pr) =>
            `    ${pr.number}) printf '%b' ${JSON.stringify(pr.closes.join("\n"))}; echo; exit 0 ;;`,
        )
        .join("\n");
      writeFileSync(
        join(path, "gh"),
        [
          "#!/usr/bin/env bash",
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
          // label の付け替えを記録する（**書いたら読み直す**の確認に使う）
          'if [[ $* == *"issue edit"* ]]; then',
          `  echo "$*" >>${JSON.stringify(join(repo, "edits.log"))}`,
          `  exit ${options.editFails === true ? 1 : 0}`,
          "fi",
          'if [[ $* == *"issue view"* ]]; then',
          "  for word in $*; do",
          "    case $word in",
          ...Object.entries(options.labelsOf ?? {}).flatMap(([number, labels]) => [
            `    ${number}) printf '%b' ${JSON.stringify(labels.join("\n"))}; echo; exit 0 ;;`,
          ]),
          "    esac",
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
      const lock = join(repo, ".git", "valence-loop-claim.lock");
      const held = spawnSync(
        "bash",
        [
          "-c",
          `setsid flock -x ${JSON.stringify(lock)} -c "sleep 5" </dev/null >/dev/null 2>&1 & echo $!`,
        ],
        { encoding: "utf8" },
      ).stdout.trim();

      try {
        expect(run(["audit"], { env: { LOOP_CLAIM_LOCK_WAIT_SEC: "1" } }).status).toBe(2);
        expect(existsSync(join(repo, "edits.log"))).toBe(false);
      } finally {
        spawnSync("kill", [held]);
      }
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
      const lock = join(repo, ".git", "valence-loop-claim.lock");
      const held = spawnSync(
        "bash",
        [
          "-c",
          `setsid flock -x ${JSON.stringify(lock)} -c "sleep 5" </dev/null >/dev/null 2>&1 & echo $!`,
        ],
        { encoding: "utf8" },
      ).stdout.trim();

      try {
        // **ロックを取れないうちは、記録に触らない。**
        const audited = run(["audit"], { env: { LOOP_CLAIM_LOCK_WAIT_SEC: "1" } });

        expect(audited.status).toBe(2);
        expect(existsSync(join(repo, ".git", "valence-loop-claim-82"))).toBe(true);
      } finally {
        spawnSync("kill", [held]);
      }
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
