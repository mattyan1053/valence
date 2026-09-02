/**
 * **切られた `./task check` の残りを落とす**（#571）。
 *
 * **`./task check:leftovers` は「落としてから打ち直すこと」と言うが、その手が無かった。**
 * **打っても当たらない**——**しかも空振りしても何も言われない。**
 *
 * ## 測ったこと（2026-09-02）
 *
 * - **出る番号はホスト側である**（`bin/loop-check-leftovers` は `docker top`）
 *   ——**`docker exec … kill` は当たらない。**
 * - **ホスト側からは落とせる。** **コンテナは `node` で走るが、ホストの UID 1000
 *   （実行している人）に写っている**ので、**`kill -0` が通る**（実測）。
 * - **親だけでは残る。** **`pnpm check` を落としても `vitest` が生き残り、2 回打った**
 *   （worker-2 の実測）。
 *
 * ## 何を守るか
 *
 * - **他の作業場のものを落とさない**（#186）——**番号は
 *   `bin/loop-check-leftovers --pids` に訊く。** **あちらは自分の作業場だけを見る。**
 * - **子まで落ちる**——**判定は `--pids` が持っている**（**ここには書き写さない**）。
 * - **落とし損ねたら、そう言う**——**「何も起きない」を「落とせた」と読ませない。**
 *
 * **実物のプロセスは触らない。** **`kill` も番号の出どころも身代わりを置く**
 * ——**走っているものと競らない**（`AGENTS.md` §5）。
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-check-kill", import.meta.url));

type Sandbox = {
  run: (args?: string[]) => { status: number; stdout: string; stderr: string };
  killed: () => string[];
  asked: () => string[];
};

describe("bin/loop-check-kill", () => {
  const sandboxes: string[] = [];

  afterEach(() => {
    for (const dir of sandboxes.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * `bin/loop-check-leftovers` と `kill` の身代わりを置く。
   *
   * `pids` は 1 回目に返す番号、`after` は落としたあとの残り（`[]` なら片付いた）。
   */
  function withStubs({
    pids = ["100"],
    after = [] as string[],
    lookupStatus = 1,
    verifyStatus = 0,
    /** **落ちなかった番号。** `kill -0` に答えさせる（**親が消えても番号は番号**）。 */
    alive = [] as string[],
  } = {}): Sandbox {
    const dir = mkdtempSync(join(tmpdir(), "check-kill-"));
    sandboxes.push(dir);
    const killLog = join(dir, "kill.log");
    const askLog = join(dir, "ask.log");
    const state = join(dir, "round");

    // **`--pids` と、確かめ直す呼び出しの両方を受ける身代わり**
    writeFileSync(
      join(dir, "loop-check-leftovers"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >>${JSON.stringify(askLog)}`,
        'if [[ $1 == "--pids" ]]; then',
        `  ${lookupStatus === 0 ? "exit 0" : lookupStatus === 2 ? "exit 2" : ""}`,
        `  printf '%s\\n' ${pids.map((pid) => JSON.stringify(pid)).join(" ") || '""'}`,
        "  exit 1",
        "fi",
        // **落としたあとの確かめ**
        `if [[ -s ${JSON.stringify(state)} ]]; then`,
        verifyStatus === 2
          ? "  exit 2"
          : after.length === 0
            ? "  exit 0"
            : `  printf '%s\\n' ${after.map((line) => JSON.stringify(line)).join(" ")} >&2; exit 1`,
        "fi",
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(join(dir, "loop-check-leftovers"), 0o755);

    writeFileSync(
      join(dir, "kill"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >>${JSON.stringify(killLog)}`,
        `printf 'done' >${JSON.stringify(state)}`,
        // **`-0` は生存確認である**——**落としたことにしない**
        'if [[ $1 == "-0" ]]; then',
        `  for pid in ${alive.map((pid) => JSON.stringify(pid)).join(" ") || '""'}; do`,
        '    [[ $2 == "$pid" ]] && exit 0',
        "  done",
        "  exit 1",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(join(dir, "kill"), 0o755);

    return {
      run: (args = ["valence"]) => {
        const result = spawnSync(SCRIPT, args, {
          cwd: dir,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH ?? ""}`,
            LOOP_CHECK_KILL_GRACE_SEC: "0",
            LOOP_CHECK_LEFTOVERS: join(dir, "loop-check-leftovers"),
            // **`kill` は bash の組み込み**なので、PATH に置いても当たらない
            LOOP_CHECK_KILL_CMD: join(dir, "kill"),
          },
        });
        return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
      },
      killed: () => {
        try {
          return readFileSync(killLog, "utf8").split("\n").filter(Boolean);
        } catch {
          return [];
        }
      },
      asked: () => readFileSync(askLog, "utf8").split("\n").filter(Boolean),
    };
  }

  it("残っていなければ、何も落とさずに 0 を返す", () => {
    // **落とすものが無いのに `kill` を打たない**——**打つと、次の失敗モードが増える**
    const stub = withStubs({ lookupStatus: 0 });
    const done = stub.run();

    expect(done.status).toBe(0);
    expect(stub.killed(), "落とすものが無いのに打っている").toEqual([]);
  });

  it("残っていたら落として、0 を返す", () => {
    const stub = withStubs({ pids: ["100", "101"] });
    const done = stub.run();

    expect(done.status, done.stderr).toBe(0);
    expect(stub.killed().join(" ")).toContain("100");
    expect(stub.killed().join(" ")).toContain("101");
  });

  it("番号は自分で探さず、`--pids` に訊く", () => {
    // **他の作業場のものを落とさない**（#186）——**あちらは自分の作業場だけを見る。**
    // **「何がその走りのぶんか」も、あちらが決めている**（§5）
    const stub = withStubs();
    stub.run();

    expect(stub.asked().some((call) => call.startsWith("--pids "))).toBe(true);
  });

  it("落としたあと、残っていないことを確かめる", () => {
    // **「何も起きない」を「落とせた」と読ませない**
    const stub = withStubs();
    stub.run();

    expect(stub.asked().filter((call) => !call.startsWith("--pids"))).not.toEqual([]);
  });

  it("落とし切れなかったら、1 を返して残りを出す", () => {
    // **空振りが分かる**（#571 の完了条件）
    const stub = withStubs({ after: ["u 103 102 sh -c vitest run"] });
    const done = stub.run();

    expect(done.status, "落とせていないのに 0 を返している").toBe(1);
    expect(`${done.stdout}${done.stderr}`, "残りが出ない").toContain("落とし切れません");
  });

  it("番号を訊けなければ、判定できないと言う", () => {
    // **「残っていない」へ倒さない**——**見ていないことを「居ない」にしない**
    const stub = withStubs({ lookupStatus: 2 });
    const done = stub.run();

    expect(done.status).toBe(2);
    expect(stub.killed(), "判定できないのに落としている").toEqual([]);
  });

  it("作業場の名前が無ければ、使い方を出して 2 を返す", () => {
    const stub = withStubs();

    expect(stub.run([]).status).toBe(2);
  });
});

describe("落ちたことを、親に頼らず確かめる（#572 のレビュー）", () => {
  /**
   * **落とす対象は「子まで辿った番号」なのに、確かめるのは通常モードだった**
   * ——**あちらはコマンド名で当てる**ので、**親が消えたあとの子には当たらない。**
   *
   * **ただし `kill -0` では見られない**（#572 のレビュー 3 周目）。**あれは
   * 「シグナルを送れるか」しか見ない**ので、**KILL の直後、まだ刈り取られていない
   * ゾンビにも通る**——**実測で 20/20**（**落とせているのに「残っている」と答える**）。
   *
   * **状態で見る。** **`Z` は死んでいる**（**親の回収を待っているだけ**）。
   *
   * **語では測らない**（`AGENTS.md` §4）——**`kill -0` はこの 2 ファイルの散文に
   * 5 行出る**ので、**文字列で当てると、直っていなくても緑になる。**
   * **終了コードと、出た番号で見る。**
   */
  const sandboxes: string[] = [];

  afterEach(() => {
    for (const dir of sandboxes.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** `ps -o stat=` が返す状態。**空なら「もう居ない」。** */
  function run({
    pids,
    states = {} as Record<string, string>,
    verifyStatus = 0,
  }: {
    pids: string[];
    states?: Record<string, string>;
    verifyStatus?: number;
  }): { status: number; stdout: string; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), "check-kill-alive-"));
    sandboxes.push(dir);
    writeFileSync(
      join(dir, "leftovers"),
      [
        "#!/usr/bin/env bash",
        'if [[ $1 == "--pids" ]]; then',
        `  printf '%s\\n' ${pids.map((pid) => JSON.stringify(pid)).join(" ")}`,
        "  exit 1",
        "fi",
        // **通常モードは「もう見つからない」と答える**——**親が消えたあとの形**
        `  ${verifyStatus === 2 ? "exit 2" : "exit 0"}`,
      ].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(join(dir, "leftovers"), 0o755);
    writeFileSync(join(dir, "kill"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    chmodSync(join(dir, "kill"), 0o755);
    writeFileSync(
      join(dir, "ps"),
      [
        "#!/usr/bin/env bash",
        // **`-o stat= -p <番号>` で呼ばれる**——**最後の引数が番号である**
        'pid="${@: -1}"',
        ...Object.entries(states).map(
          ([pid, state]) =>
            `[[ $pid == ${JSON.stringify(pid)} ]] && { echo ${JSON.stringify(state)}; exit 0; }`,
        ),
        // **知らない番号は「もう居ない」**
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(join(dir, "ps"), 0o755);
    const result = spawnSync(SCRIPT, ["valence"], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        LOOP_CHECK_KILL_GRACE_SEC: "0",
        LOOP_CHECK_LEFTOVERS: join(dir, "leftovers"),
        LOOP_CHECK_KILL_CMD: join(dir, "kill"),
        LOOP_CHECK_PS_CMD: join(dir, "ps"),
      },
    });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  it("落とせているのに「残っている」と言わない（ゾンビ）", () => {
    // **これがこの周回の指摘そのもの**である——**KILL の直後、まだ刈り取られて
    // いない子は `Z` で残る。** **シグナルは通るが、走ってはいない。**
    const done = run({ pids: ["100", "101"], states: { "100": "Z", "101": "Z+" } });

    expect(done.status, `落ちているのに残っていると言っている: ${done.stderr}`).toBe(0);
  });

  it("もう居なければ、0 を返す", () => {
    expect(run({ pids: ["100"], states: {} }).status).toBe(0);
  });

  it("1 つでも走っていたら、1 を返してその番号を出す", () => {
    // **上の判定が空でないことを、ここが支えている**——**通常モードは 0 を返している**
    // （**コマンド名では当たらない**）**のに、赤くなる**
    const done = run({ pids: ["100", "101", "102"], states: { "102": "Sl" } });

    expect(done.status, "走っているのに成功と言っている").toBe(1);
    expect(done.stderr, "どれが残ったかが出ない").toContain("102");
  });

  it("再検査できないときは、2 を返す（1 に潰さない）", () => {
    // **`docker` を引けなくなると `bin/loop-check-leftovers` は 2 を返す**
    // ——**「落とし切れなかった」と混ぜると、呼ぶ側が見分けられない**
    expect(run({ pids: ["100"], states: {}, verifyStatus: 2 }).status).toBe(2);
  });
});
