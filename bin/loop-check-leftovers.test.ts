/**
 * **切られた走りが、この作業場に残っていないか**（#528）。
 *
 * **`./task check` が呼び出し側の上限で切られると、コンテナの中の `pnpm check` は
 * 走り続ける**——**呼び出し側のシェルは死んでいる**（**`$status` も末尾の印も
 * 読めない**）**のに、中で走っているものは残る。** **そのまま次を打つと、
 * 同じ木で 2 本走る**（#509 で測った形。**load 41.8 で vitest が時間切れになった**）。
 *
 * **見るのは自分の作業場だけ**である（#186）——**compose の project label で絞る。**
 * **別の作業場は別のコンテナ**なので、**そこを覗きに行かない。**
 *
 * **落とさない。** **踏んだ 2 回とも、気づけば人が落とせている**——**言えば足りる。**
 * **`./task test:watch` のような、人が意図して長く走らせているもの**もあるので、
 * **殺す側へ倒すと、正しく走っているものを止める。**
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-check-leftovers", import.meta.url));

/** `docker top` が返す表。**1 行目は見出し**（実物と同じ形）。 */
const HEADER = "UID                 PID                 PPID                CMD";

describe("bin/loop-check-leftovers", () => {
  const sandboxes: string[] = [];

  afterEach(() => {
    for (const dir of sandboxes.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * **`docker` の身代わりを置く。** **実物のコンテナを触らない**（#186 と同じ理由
   * ——**走っているものと競らない**）。
   *
   * `container` が空なら「そのコンテナは無い」。`top` が表の中身になる。
   */
  function withDocker({
    container = "abc123",
    top = [HEADER],
    fail = false,
  }: {
    container?: string;
    top?: string[];
    fail?: boolean;
  } = {}): {
    run: (args?: string[]) => { status: number; stdout: string; stderr: string };
    calls: () => string[];
  } {
    const dir = mkdtempSync(join(tmpdir(), "leftovers-"));
    sandboxes.push(dir);
    const log = join(dir, "docker.log");
    writeFileSync(
      join(dir, "docker"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >>${JSON.stringify(log)}`,
        fail ? "exit 1" : "",
        'if [[ $1 == "ps" ]]; then',
        `  printf '%s\\n' ${container === "" ? '""' : JSON.stringify(container)}`,
        "  exit 0",
        "fi",
        'if [[ $1 == "top" ]]; then',
        // **1 行 1 プロセスで出す**——**`docker top` はそう返す。**
        // **1 つの文字列にまとめると改行が畳まれ、行ごとの判定を測れない**
        `  printf '%s\\n' ${top.map((line) => JSON.stringify(line)).join(" ")}`,
        "  exit 0",
        "fi",
        "exit 2",
      ].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(join(dir, "docker"), 0o755);
    return {
      run: (args = ["valence"]) => {
        const result = spawnSync(SCRIPT, args, {
          cwd: dir,
          encoding: "utf8",
          env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
        });
        return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
      },
      calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    };
  }

  it("走りが残っていなければ、0 を返す", () => {
    // **`pnpm dev` は常に居る**——**それを「残っている」と読まない**
    const docker = withDocker({
      top: [HEADER, "u 9129 9034 node /usr/local/bin/pnpm dev", "u 9264 9263 next-server"],
    });

    expect(docker.run().status, "居ないのに居ると言っている").toBe(0);
  });

  it("残っていたら、1 を返して何が残っているかを言う", () => {
    const docker = withDocker({
      top: [
        HEADER,
        "u 9129 9034 node /usr/local/bin/pnpm dev",
        "u 3632112 3632069 sh -c vitest run --project '!db'",
      ],
    });

    const found = docker.run();

    expect(found.status, "残っているのに 0 を返している").toBe(1);
    expect(found.stderr, "何が残っているかが出ない").toContain("vitest run");
  });

  it("`pnpm check` が残っていても見つける", () => {
    // **切られるのは `./task check` の側**である——**その子が残る**
    const docker = withDocker({
      top: [HEADER, "u 100 1 node /usr/local/bin/pnpm check"],
    });

    expect(docker.run().status).toBe(1);
  });

  it("`./task test:watch` は、残骸として数えない", () => {
    // **人が意図して走らせているもの**である（#529 のレビュー）——**止めないと決めた以上、
    // 毎回「残っています」と言うのは、その判断と食い違う**（言うほうが無視される）。
    //
    // **`\b` は `t` と `:` の間でも成立する**ので、**`pnpm test\b` に当たっていた。**
    // **実物の `docker top` にこの行が出ることを確かめてある**（#529）。
    const docker = withDocker({
      top: [
        HEADER,
        "u 3864163 9010 node /usr/local/bin/pnpm test:watch",
        "u 3864200 3864163 sh -c vitest --project '!db'",
      ],
    });

    const found = docker.run();

    expect(found.status, "watch を残骸として数えている").toBe(0);
    expect(found.stderr, "watch を挙げている").not.toContain("test:watch");
  });

  it("`pnpm test` は、これまでどおり数える", () => {
    // **消してはいけないほう**——**`test:watch` を外したついでに、`test` まで外さない**
    const docker = withDocker({ top: [HEADER, "u 100 1 node /usr/local/bin/pnpm test"] });

    expect(docker.run().status, "走り切っていない `pnpm test` を見逃している").toBe(1);
  });

  it("自分の作業場だけを見る", () => {
    // **別の作業場は別のコンテナ**である（#186）——**project label で絞る。**
    // **絞らずに引くと、他人の走りを自分のものとして数える。**
    const docker = withDocker();

    docker.run(["valence-worker-b"]);

    const ps = docker.calls().find((line) => line.startsWith("ps "));
    expect(ps, "コンテナを引いていない").toBeDefined();
    expect(ps, "作業場で絞っていない").toContain("com.docker.compose.project=valence-worker-b");
    expect(ps, "app のコンテナで絞っていない").toContain("com.docker.compose.service=app");
  });

  it("コンテナが上がっていなければ、0 を返す", () => {
    // **止まっているコンテナに、走りは残っていない**
    const docker = withDocker({ container: "" });

    expect(docker.run().status).toBe(0);
    expect(
      docker.calls().some((line) => line.startsWith("top ")),
      "止まっているのに覗いている",
    ).toBe(false);
  });

  it("docker が使えなければ、2 で「判定できない」と言う", () => {
    // **「見つからなかった」へ倒さない**——**見ていないことを、居ないことにしない**
    const docker = withDocker({ fail: true });

    const answered = docker.run();

    expect(answered.status).toBe(2);
    expect(answered.stderr, "判定できないことが出ない").toContain("判定できません");
  });

  it("作業場の名前を渡さなければ、使い方の誤りとして落ちる", () => {
    // **名前の正規化は `task` が持つ**（`AGENTS.md` §5）——**ここでは組み立てない**
    const docker = withDocker();

    expect(docker.run([]).status).toBe(2);
  });
});

describe("`./task check` が、打つ前に見る", () => {
  const runner = readFileSync(join(fileURLToPath(new URL("..", import.meta.url)), "task"), "utf8");
  const check = runner.slice(runner.indexOf("cmd_check() {")).split("\n}\n")[0] ?? "";

  it("走らせる前に見る", () => {
    // **打ったあとに気づいても遅い**——**2 本走り始めている**（#509）
    const looked = check.indexOf("check_leftovers");
    const ran = check.indexOf("exec_app pnpm check");

    expect(looked, "見ていない").toBeGreaterThanOrEqual(0);
    expect(ran, "check を打っていない").toBeGreaterThanOrEqual(0);
    expect(looked, "打ってから見ている").toBeLessThan(ran);
  });

  it("作業場の名前を組み立てるのは、1 箇所である", () => {
    // **正規化は `task` が持つ**（`AGENTS.md` §5）——**呼ぶ側で組み立てない。**
    // **口が 2 つある**（`./task check` の中と、`./task check:leftovers`）ので、
    // **名前を渡すところが増えると、片方だけ直して食い違う。**
    const calls = runner.split("\n").filter((row) => row.includes("./bin/loop-check-leftovers"));

    expect(calls, "渡すところが 1 箇所ではない").toHaveLength(1);
    expect(calls[0], "作業場を渡していない").toContain('"$(workspace_name)"');
  });

  it("単独で打てる口がある", () => {
    // **`./task check` の中だけだと、手順書の受け方で報せが消える**
    // （#529 のレビュー 3 周目）——**リダイレクトの外から打てること。**
    expect(runner, "単独で打てない").toContain("cmd_check_leftovers()");
  });

  it("見つかっても、check は止めない", () => {
    // **`./task test:watch` のように、人が意図して走らせているものもある**
    // ——**止める側へ倒すと、正しく走っているものを止める。** **言うだけにする。**
    const line = check.split("\n").find((row) => row.includes("check_leftovers")) ?? "";

    expect(line, "落ちる側になっている").toContain("|| true");
  });
});
