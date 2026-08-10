import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
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

  /** **同時に**走らせる。`spawnSync` の繰り返しは直列で、同時性を試せない（#74 の前例）。 */
  function raceFor(count: number, issue = "84"): Promise<Run[]> {
    return Promise.all(
      Array.from({ length: count }, () => {
        return new Promise<Run>((resolve) => {
          const child = spawn(
            "bash",
            [
              "-c",
              `printf 'start %s\\n' "$(date +%s%N)" >>"$RACE_LOG"; ` +
                `${JSON.stringify(SCRIPT)} ${issue}; code=$?; ` +
                `printf 'end %s\\n' "$(date +%s%N)" >>"$RACE_LOG"; exit $code`,
            ],
            {
              cwd: repo,
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

  function run(...args: string[]): Run {
    const result = spawnSync(SCRIPT, args, {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PATH: path },
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

  it("同時に取りに行っても、取れるのは 1 つだけ", async () => {
    // **これが本題。** label を付けるだけだと、両方が「空いている」と読んでから両方が書ける
    withGh({ labels: ["ready"] });

    const results = await raceFor(4);

    expect(results.filter((result) => result.status === 0)).toHaveLength(1);
    expect(results.filter((result) => result.status === 1)).toHaveLength(3);
    // **書き込みそのものも 1 回だけ。** exit だけ見ると、2 回書いてから譲っても通る
    expect(editCount()).toBe(1);
  });

  it("試したときに、本当に重なっている", async () => {
    // **同時性そのものが主題。** 直列に走らせていると、直列化を外す変異が赤くならない
    // （#74 でそうなった）。**全員が走り出してから、最初の 1 つが終わる**ことを確かめる
    withGh({ labels: ["ready"] });

    await raceFor(4);

    const marks = readFileSync(join(repo, "race.log"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [kind, at] = line.split(" ");
        return { kind, at: BigInt(at ?? "0") };
      });
    const starts = marks.filter((mark) => mark.kind === "start").map((mark) => mark.at);
    const ends = marks.filter((mark) => mark.kind === "end").map((mark) => mark.at);

    expect(starts).toHaveLength(4);
    expect(ends).toHaveLength(4);
    expect(starts.reduce((a, b) => (a > b ? a : b))).toBeLessThan(
      ends.reduce((a, b) => (a < b ? a : b)),
    );
  });

  it("取れなかった側は、待たされずに戻る", async () => {
    // **待つと、そこが新しい詰まりどころになる**（#74 の lease と同じ判断）。
    // 誰かが取っている最中でも、**待ち続けずに譲って次へ進む**
    withGh({ labels: ["ready"] });
    const holder = spawn("flock", [
      "-x",
      join(repo, ".git", "valence-loop-claim.lock"),
      "sleep",
      "20",
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const result = spawnSync(SCRIPT, ["84"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PATH: path, LOOP_CLAIM_LOCK_WAIT_SEC: "1" },
      timeout: 15_000,
    });
    holder.kill();

    expect(result.status).toBe(1);
    expect(editCount()).toBe(0);
  });

  it("書いたのに変わっていなければ、取れたことにしない", () => {
    // **書き込んでから読み直して確かめる。** 書けたつもりで進むと、
    // **label は ready のまま実装が始まり**、次の周回がもう一度同じものを取る
    withGh({ labels: ["ready"], editIsNoop: true, viewDelay: "0" });

    const result = run("84");

    expect(result.status).toBe(2);
  });

  it("すでに ready が外れていれば取れない", () => {
    // 先に取った側がいる。**読み直しはロックの中で行う**ので、ここで必ず気づく
    withGh({ labels: ["in-progress"], viewDelay: "0" });

    expect(run("84").status).toBe(1);
  });

  it("Issue を読めなければ 2 で落ちる", () => {
    // **判定不能を「取れた」に倒さない。** 倒すと 2 人が同じものを実装する
    writeFileSync(join(path, "gh"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });

    expect(run("84").status).toBe(2);
  });

  it("使い方の誤りは 2 で落ちる", () => {
    withGh({ labels: ["ready"], viewDelay: "0" });

    expect(run().status).toBe(2);
    expect(run("84", "余計な引数").status).toBe(2);
    expect(run("#84").status).toBe(2);
  });
});
