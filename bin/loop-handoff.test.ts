import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-handoff", import.meta.url));

type Run = { status: number; stdout: string; stderr: string };

/** GitHub の状態。**偽の `gh` はこれを返すだけ**にして、判断だけを試す。 */
type State = {
  /** open PR。`labels` は付いている label 名。 */
  prs?: { number: number; labels?: string[] }[];
  ready?: number;
  inProgress?: number;
  backlog?: number;
  /** `gh` が失敗する（判定不能）。 */
  fails?: boolean;
  /** その取得だけが失敗する。**最初の 1 つだけを試すと、後ろの取得を試せない。** */
  failsOn?: string;
};

describe("bin/loop-handoff", () => {
  let repo: string;
  let path: string;

  /**
   * **本物の `gh` を呼ばない。** 見たいのは「GitHub の状態から誰へ渡すか」であって、
   * 取得の仕方ではない。PATH を絞って偽物だけを置く。
   */
  function withState(state: State): void {
    const prs = (state.prs ?? [])
      .map((pr) => `${pr.number}\t${(pr.labels ?? []).join(",")}`)
      .join("\n");
    writeFileSync(
      join(path, "gh"),
      [
        "#!/usr/bin/env bash",
        ...(state.fails === true ? ['echo "gh が落ちた" >&2', "exit 1"] : []),
        ...(state.failsOn === undefined
          ? []
          : [
              `if [[ $* == *${JSON.stringify(state.failsOn)}* ]]; then`,
              '  echo "gh が落ちた" >&2',
              "  exit 1",
              "fi",
            ]),
        'if [[ $* == *"pr list"* ]]; then',
        // **`%b` で出す。** `%s` だと `\t` がリテラルのまま出て、列が壊れる
        // （`bin/loop-await-review` のテストで 1 度踏んだ）
        `  printf '%b' ${JSON.stringify(prs)}`,
        `  [[ -n ${JSON.stringify(prs)} ]] && echo`,
        "  exit 0",
        "fi",
        'if [[ $* == *"--label ready"* ]]; then echo ' + String(state.ready ?? 0) + "; exit 0; fi",
        'if [[ $* == *"--label in-progress"* ]]; then echo ' +
          String(state.inProgress ?? 0) +
          "; exit 0; fi",
        'if [[ $* == *"--label backlog"* ]]; then echo ' +
          String(state.backlog ?? 0) +
          "; exit 0; fi",
        'echo "スタブ: 想定外の gh 呼び出し: $*" >&2',
        "exit 2",
      ].join("\n"),
      { mode: 0o755 },
    );
  }

  function run(...args: string[]): Run {
    const result = spawnSync(SCRIPT, args, {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PATH: path },
    });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "loop-handoff-"));
    expect(spawnSync("git", ["init", "--quiet", repo]).status).toBe(0);
    path = join(repo, "path");
    mkdirSync(path, { recursive: true });
    for (const command of ["bash", "git", "flock", "cat", "mkdir", "rm", "printf", "date"]) {
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

  it("changes-requested の PR があれば worker へ渡す", () => {
    // **相手に具体的な持ち物があるときだけ送る。** 「暇そうだから起こす」は送らない
    withState({ prs: [{ number: 12, labels: ["changes-requested"] }] });

    const handoff = run("master");

    expect(handoff.status).toBe(0);
    expect(handoff.stdout).toMatch(/^worker\t/);
    expect(handoff.stdout).toContain("12");
  });

  it("ゲートを回せる PR があれば master へ渡す", () => {
    withState({ prs: [{ number: 12 }] });

    const handoff = run("worker");

    expect(handoff.status).toBe(0);
    expect(handoff.stdout).toMatch(/^master\t/);
  });

  it("ready が 1 件で着手されていなければ worker へ渡す", () => {
    withState({ ready: 1 });

    expect(run("master").stdout).toMatch(/^worker\t/);
  });

  it("backlog はあるが ready が 0 なら master へ渡す（昇格の番）", () => {
    withState({ backlog: 3 });

    expect(run("worker").stdout).toMatch(/^master\t/);
  });

  it("自分自身へは渡さない", () => {
    // **自分が動けるなら次の周回でやればよい。** 自己通知は ping-pong の入口になる
    withState({ ready: 1 });

    const handoff = run("worker");

    expect(handoff.status).toBe(1);
    expect(handoff.stdout).toBe("");
  });

  it.each(["master", "worker"])("誰も動けなければ %s からも渡さない", (role) => {
    // ここは `bin/loop-stall` が `no-work` として数える領域である。
    // **両方の役から見る。** 片方だけだと「自分自身へは送らない」に吸われて、
    // **持ち物が無いのに起こす**変異を捕まえられない
    withState({});

    expect(run(role).status).toBe(1);
  });

  it("同じ状態で 2 通目を送らない", () => {
    // **ping-pong を作らない。** 送った状態を覚えておき、変わっていなければ黙る
    withState({ prs: [{ number: 12, labels: ["changes-requested"] }] });

    expect(run("master").status).toBe(0);
    expect(run("master").status).toBe(1);
  });

  it("状態が変われば、また送る", () => {
    withState({ prs: [{ number: 12, labels: ["changes-requested"] }] });
    expect(run("master").status).toBe(0);

    withState({ prs: [{ number: 13, labels: ["changes-requested"] }] });

    expect(run("master").status).toBe(0);
  });

  it("送り合いにならない", () => {
    // **これが本体。** 「暇 → 起こす → 暇 → 起こす」で焼き切れた事故と同じ形を作らない。
    // 交互に呼び続けても、送るのは持ち物がある側への 1 通だけである
    withState({ prs: [{ number: 12, labels: ["changes-requested"] }] });

    const sent = ["master", "worker", "master", "worker", "master", "worker"]
      .map((role) => run(role))
      .filter((handoff) => handoff.status === 0);

    expect(sent).toHaveLength(1);
  });

  it.each([
    { name: "すべて", state: { fails: true } },
    // **後ろの取得だけが落ちる場合も試す。** 最初の 1 つだけだと、
    // **2 つ目以降で握り潰していても気づけない**
    { name: "ready の取得だけ", state: { failsOn: "--label ready" } },
  ])("状態を読めなければ 2 で落ちる（$name）", ({ state }) => {
    // **判定不能を「送らない」に倒さない。** 倒すと、止まっていることに気づけない
    withState(state);

    expect(run("master").status).toBe(2);
  });

  it("役の綴りを固定する", () => {
    withState({});

    expect(run("workers").status).toBe(2);
    expect(run().status).toBe(2);
  });
});
