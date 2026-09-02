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
   * `groups` は `--groups` が返すグループ、`alive` は落としたあとに `--alive` が
   * 返す行（**空なら片付いた**）。
   */
  function withStubs({
    groups = ["100"],
    alive = [] as string[],
    groupsStatus = 1,
    aliveStatus = -1,
  } = {}): {
    run: (args?: string[]) => { status: number; stdout: string; stderr: string };
    killed: () => string[];
    asked: () => string[];
  } {
    const dir = mkdtempSync(join(tmpdir(), "check-kill-"));
    sandboxes.push(dir);
    const killLog = join(dir, "kill.log");
    const askLog = join(dir, "ask.log");
    writeFileSync(
      join(dir, "leftovers"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >>${JSON.stringify(askLog)}`,
        'if [[ $1 == "--groups" ]]; then',
        `  ${groupsStatus === 0 ? "exit 0" : groupsStatus === 2 ? "exit 2" : ""}`,
        `  printf '%s\\n' ${groups.map((g) => JSON.stringify(g)).join(" ") || '""'}`,
        "  exit 1",
        "fi",
        'if [[ $1 == "--alive" ]]; then',
        `  ${aliveStatus === 2 ? "exit 2" : ""}`,
        alive.length === 0
          ? "  exit 0"
          : `  printf '%s\\n' ${alive.map((l) => JSON.stringify(l)).join(" ")}; exit 1`,
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(join(dir, "leftovers"), 0o755);
    writeFileSync(
      join(dir, "kill"),
      ["#!/usr/bin/env bash", `printf '%s\\n' "$*" >>${JSON.stringify(killLog)}`, "exit 0"].join(
        "\n",
      ),
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
            LOOP_CHECK_KILL_GRACE_SEC: "0",
            LOOP_CHECK_LEFTOVERS: join(dir, "leftovers"),
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
    const stub = withStubs({ groupsStatus: 0 });

    expect(stub.run().status).toBe(0);
    expect(stub.killed(), "落とすものが無いのに打っている").toEqual([]);
  });

  it("グループごと落とす", () => {
    // **番号の一覧ではなく、木ごと**である (#574)——**負の番号がプロセスグループ**
    const stub = withStubs({ groups: ["100", "200"] });
    const done = stub.run();

    expect(done.status, done.stderr).toBe(0);
    expect(stub.killed().join(" "), "グループへ送っていない").toContain("-100");
    expect(stub.killed().join(" ")).toContain("-200");
  });

  it("グループは自分で探さず、`--groups` に訊く", () => {
    // **他の作業場のものを落とさない**（#186）。**「何がその走りのぶんか」も
    // あちらが決めている**（§5）
    const stub = withStubs();
    stub.run();

    expect(stub.asked().some((call) => call.startsWith("--groups "))).toBe(true);
  });

  it("落としたあと、グループが空いたかを訊く", () => {
    // **名前では見ない**——**列挙のあとに fork された子は、名前に当たらない**（#574）
    const stub = withStubs();
    stub.run();

    expect(stub.asked().some((call) => call.startsWith("--alive valence 100"))).toBe(true);
  });

  it("グループに残っていたら、1 を返して何が残ったかを出す", () => {
    // **列挙のあとに fork された子が、ここで捕まる**（#574 そのもの）
    const stub = withStubs({ alive: ["102 100 Sl node …/forks.js"] });
    const done = stub.run();

    expect(done.status, "残っているのに成功と言っている").toBe(1);
    expect(`${done.stdout}${done.stderr}`, "残りが出ない").toContain("102");
  });

  it("グループを訊けなければ、判定できないと言う", () => {
    // **「残っていない」へ倒さない**——**見ていないことを「居ない」にしない**
    const stub = withStubs({ groupsStatus: 2 });
    const done = stub.run();

    expect(done.status).toBe(2);
    expect(stub.killed(), "判定できないのに落としている").toEqual([]);
  });

  it("確かめられなければ、2 を返す（1 に潰さない）", () => {
    // **「判定できない」と「落とし切れなかった」を混ぜない**（#572 のレビュー）
    expect(withStubs({ aliveStatus: 2 }).run().status).toBe(2);
  });

  it("作業場の名前が無ければ、使い方を出して 2 を返す", () => {
    expect(withStubs().run([]).status).toBe(2);
  });
});
