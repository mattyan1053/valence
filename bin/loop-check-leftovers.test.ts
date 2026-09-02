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
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-check-leftovers", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * `docker top -eo pid,pgid,stat,cmd` が返す表。**1 行目は見出し**（実物と同じ形）。
 *
 * **列を名指しで受けている** (#574)——**既定の `UID PID PPID CMD` ではない。**
 */
const HEADER = "PID                 PGID                STAT                CMD";

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
      top: [HEADER, "9129 9129 Sl node /usr/local/bin/pnpm dev", "9264 9264 Sl next-server"],
    });

    expect(docker.run().status, "居ないのに居ると言っている").toBe(0);
  });

  it("残っていたら、1 を返して何が残っているかを言う", () => {
    const docker = withDocker({
      top: [
        HEADER,
        "9129 9129 Sl node /usr/local/bin/pnpm dev",
        "3632112 3632112 Sl sh -c vitest run --project '!db'",
      ],
    });

    const found = docker.run();

    expect(found.status, "残っているのに 0 を返している").toBe(1);
    expect(found.stderr, "何が残っているかが出ない").toContain("vitest run");
  });

  it("`pnpm check` が残っていても見つける", () => {
    // **切られるのは `./task check` の側**である——**その子が残る**
    const docker = withDocker({
      top: [HEADER, "100 100 Sl node /usr/local/bin/pnpm check"],
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
        "3864163 3864163 Sl node /usr/local/bin/pnpm test:watch",
        "3864200 3864200 Sl sh -c vitest --project '!db'",
      ],
    });

    const found = docker.run();

    expect(found.status, "watch を残骸として数えている").toBe(0);
    expect(found.stderr, "watch を挙げている").not.toContain("test:watch");
  });

  it("`pnpm test` は、これまでどおり数える", () => {
    // **消してはいけないほう**——**`test:watch` を外したついでに、`test` まで外さない**
    const docker = withDocker({ top: [HEADER, "100 100 Sl node /usr/local/bin/pnpm test"] });

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
    // **渡す先が増えた**（自分の作業場と、別の作業場。#549 のレビュー）ので、
    // **数で見ない**——**どの呼び方も、同じ正規化を通っていること**を見る。
    const calls = runner.split("\n").filter((row) => row.includes("./bin/loop-check-leftovers"));
    const looking = runner.slice(runner.indexOf("check_leftovers() {")).split("\n}\n")[0] ?? "";

    expect(calls.length, "渡すところが無い").toBeGreaterThan(0);
    for (const call of calls) {
      expect(call, `正規化を通さずに名前を渡している: ${call}`).toMatch(
        /"\$\(workspace_name\)"|"\$name"/,
      );
    }
    expect(looking, "別の作業場の名前を正規化していない").toContain(
      'name="$(normalize_workspace_name',
    );
  });

  it("別の作業場も見る", () => {
    // **PID では見えない** (#549 のレビュー)。**外側の上限で切られると、呼び出し側の
    // PID は消えてもコンテナの中は走り続ける**——**まさに重なるときに見えなくなる。**
    // **重なりが、2 倍の正体である**（#547 で実測）。
    const looking = runner.slice(runner.indexOf("check_leftovers() {")).split("\n}\n")[0] ?? "";

    expect(looking, "別の作業場を見ていない").toContain("--elsewhere");
    expect(looking, "作業場を並べていない").toContain("git worktree list");
  });

  it("自分の作業場を、別の作業場として数えない", () => {
    // **自分のぶんは、上の口が既に見ている**——**二重に鳴ると読まれなくなる** (#248)
    const looking = runner.slice(runner.indexOf("check_leftovers() {")).split("\n}\n")[0] ?? "";

    expect(looking, "自分の作業場を外していない").toContain('$path != "$here"');
  });

  it("別の作業場のことで、こちらの合否を変えない", () => {
    // **他人の持ち物で、こちらの分岐を決めない** (#186)——**見るだけ**である
    const looking = runner.slice(runner.indexOf("check_leftovers() {")).split("\n}\n")[0] ?? "";
    const line = looking.split("\n").find((row) => row.includes("--elsewhere")) ?? "";

    expect(line, "落ちる側になっている").toContain("|| true");
    expect(looking, "返り値を塗り替えている").toContain('return "$status"');
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

/**
 * **別の作業場で走っているものも見る**（#549 のレビュー。**P1**）。
 *
 * **`./task check` が 2 本重なると、両方が倍かかる**（#547 で実測。**単独 442〜796 秒に
 * 対し、重なると 1200 秒前後**）——**打つ前に分かれば、待てる。**
 *
 * **PID では見えない。** **外側の上限で切られると、呼び出し側の PID は消えても
 * コンテナの中の `pnpm check` は走り続ける**（**この試験ファイルの前提そのもの**）
 * ——**まさに重なるときに、記録の PID は死んでいる。**
 *
 * **見るだけである。** **落とさないし、触らない**（#186 が止めたのは、
 * **合否や分岐が他人の持ち物で決まること**——**ここは言うだけ**である）。
 */
describe("bin/loop-check-leftovers --elsewhere", () => {
  const sandboxes: string[] = [];

  afterEach(() => {
    for (const dir of sandboxes.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function withDocker(top: string[]): (args: string[]) => {
    status: number;
    stdout: string;
    stderr: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), "leftovers-elsewhere-"));
    sandboxes.push(dir);
    writeFileSync(
      join(dir, "docker"),
      [
        "#!/usr/bin/env bash",
        'if [[ $1 == "ps" ]]; then echo "abc123"; exit 0; fi',
        `if [[ $1 == "top" ]]; then printf '%s\\n' ${top.map((line) => JSON.stringify(line)).join(" ")}; exit 0; fi`,
        "exit 2",
      ].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(join(dir, "docker"), 0o755);
    return (args) => {
      const result = spawnSync(SCRIPT, args, {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      });
      return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
    };
  }

  const BUSY = [HEADER, "3632112 3632112 Sl sh -c vitest run --project '!db'"];
  const IDLE = [HEADER, "9129 9129 Sl node /usr/local/bin/pnpm dev"];

  it("走っていれば、どの作業場かと、何が走っているかを言う", () => {
    const found = withDocker(BUSY)(["--elsewhere", "valence-worker-b", "/home/x/valence-worker-b"]);

    expect(found.status, "走っているのに 0 を返している").toBe(1);
    expect(found.stderr, "どの作業場か分からない").toContain("/home/x/valence-worker-b");
    expect(found.stderr, "何が走っているかが出ない").toContain("vitest run");
  });

  it("走っていなければ、何も言わない", () => {
    // **平常時に鳴る検査は読まれなくなる** (#248)
    const quiet = withDocker(IDLE)(["--elsewhere", "valence-worker-b", "/home/x/valence-worker-b"]);

    expect(quiet.status).toBe(0);
    expect(quiet.stderr).toBe("");
  });

  it("自分の作業場向けの言い方をしない", () => {
    // **「落としてから打ち直すこと」は自分の作業場への指示**である
    // ——**他人のものを落とさせない**（#186）。
    const found = withDocker(BUSY)(["--elsewhere", "valence-worker-b", "/home/x/valence-worker-b"]);

    expect(found.stderr, "他所のものを落とせと言っている").not.toContain("落としてから");
    expect(found.stderr, "待てることを言っていない").toContain("待つか");
  });

  it("引けなかったときも、どの作業場の話かを言う", () => {
    // **成功したときは言い分けてあるのに、判定できないときだけ道が共通だった**
    // （#549 のレビュー）——**「この作業場の」と読むと、自分のコンテナを疑いに行く。**
    const dir = mkdtempSync(join(tmpdir(), "leftovers-elsewhere-fail-"));
    sandboxes.push(dir);
    writeFileSync(join(dir, "docker"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
    chmodSync(join(dir, "docker"), 0o755);
    const found = spawnSync(
      SCRIPT,
      ["--elsewhere", "valence-worker-b", "/home/x/valence-worker-b"],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      },
    );

    expect(found.status, "判定できないと言っていない").toBe(2);
    expect(found.stderr, "自分の作業場の話に見える").not.toContain("この作業場の");
    expect(found.stderr, "どの作業場か分からない").toContain("/home/x/valence-worker-b");
  });

  it("中を読めなかったときも、どの作業場の話かを言う", () => {
    // **`--elsewhere` は複数の作業場を回る** (#549 のレビュー 2 周目)——**場所なしで
    // 出ると、どれのことか分からない。** **`ps` の側だけ言い分けても半分**である。
    //
    // **`ps` は通り、`top` だけ落ちる道**を通す（**引いた直後にコンテナが止まる**）
    // ——**`docker` をまるごと落とすと、この道は 1 度も通らない。**
    const dir = mkdtempSync(join(tmpdir(), "leftovers-top-fail-"));
    sandboxes.push(dir);
    writeFileSync(
      join(dir, "docker"),
      [
        "#!/usr/bin/env bash",
        'if [[ $1 == "ps" ]]; then echo "abc123"; exit 0; fi',
        'if [[ $1 == "top" ]]; then exit 1; fi',
        "exit 2",
      ].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(join(dir, "docker"), 0o755);
    const found = spawnSync(
      SCRIPT,
      ["--elsewhere", "valence-worker-b", "/home/x/valence-worker-b"],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      },
    );

    expect(found.status, "判定できないと言っていない").toBe(2);
    expect(found.stderr, "どの作業場か分からない").toContain("/home/x/valence-worker-b");
  });

  it("場所を渡さなければ、使い方を出す", () => {
    // **どの作業場かを言えないなら、この口は役に立たない**
    expect(withDocker(BUSY)(["--elsewhere", "valence-worker-b"]).status).toBe(2);
  });

  it("これまでの呼び方は、これまでどおり", () => {
    // **自分の作業場の口を壊さない**（**呼ぶところが 2 つになる**）
    const found = withDocker(BUSY)(["valence"]);

    expect(found.status).toBe(1);
    expect(found.stderr, "自分の作業場への指示が消えている").toContain("落としてから");
  });
});

/**
 * **作業場を並べられなかったとき、黙って「他所なし」に倒さない**（#549 のレビュー 2 周目）。
 *
 * **プロセス置換の中の失敗は、呼ぶ側へ届かない**——**`done < <(git worktree list …)` は、
 * `git` が落ちてもループが 0 回で終わるだけ**である。**この PR が立てた原則**
 * （**読めなければ「判定できない」と言う**）**が、その 1 行にだけ適用されていなかった。**
 *
 * **倒れる先は「言うだけ」**にした——**自分の作業場の合否を、他所の事情で塗り替えない**
 * （#186。**この関数の他の行と同じ判断**である）。
 */
describe("作業場を並べられないとき", () => {
  const sandboxes: string[] = [];

  afterEach(() => {
    for (const dir of sandboxes.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** 実物の `git`。**並べるところ以外は、そのまま通す**（**過剰に身代わりを置かない**）。 */
  const REAL_GIT = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();

  /**
   * **実物の `./task` を、砂場で走らせる**（#556 と同じ形）。
   *
   * **本物のリポジトリで打たない。** **`git worktree list` はこの機械の実物を返す**ので、
   * **別の作業場が worktree を足せば一覧が変わり**、**その `git` が競って落ちれば
   * 「並べられない」が出る**——**合否が他人の持ち物で決まる**（`AGENTS.md` §5 / #186）。
   *
   * **砂場は本物の worktree を触らない**——**自分の repo に自分で足す。**
   */
  function runTask(
    failWorktreeList: boolean,
    busy = false,
  ): {
    status: number;
    stderr: string;
    asked: string;
    added: string;
  } {
    const stubs = mkdtempSync(join(tmpdir(), "worktree-list-"));
    sandboxes.push(stubs);
    writeFileSync(
      join(stubs, "git"),
      [
        "#!/usr/bin/env bash",
        ...(failWorktreeList ? ['if [[ $* == *"worktree list"* ]]; then exit 1; fi'] : []),
        `exec ${REAL_GIT} "$@"`,
      ].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(join(stubs, "git"), 0o755);
    // **コンテナは見に行かせない**——**見たいのは並べるところ**である
    // **何を訊かれたかを残す**（#557 のレビュー）——**「警告が出ない」だけでは、
    // `--elsewhere` を 1 度も呼ばない実装でも通る。**
    const asked = join(stubs, "docker.log");
    writeFileSync(
      join(stubs, "docker"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >>${JSON.stringify(asked)}`,
        // **`busy` のときは、足した作業場だけを走っていることにする**
        // （#557 のレビュー 2 周目）——**警告を出させないと、渡した場所を測れない。**
        ...(busy
          ? [
              'if [[ $1 == "ps" ]]; then',
              '  if [[ $* == *"-worker-b"* ]]; then echo "abc123"; fi',
              "  exit 0",
              "fi",
              `if [[ $1 == "top" ]]; then printf '%s\\n' ${JSON.stringify(HEADER)} "1 1 Sl sh -c vitest run"; exit 0; fi`,
            ]
          : ['printf ""']),
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(join(stubs, "docker"), 0o755);

    const repo = mkdtempSync(join(tmpdir(), "leftovers-repo-"));
    sandboxes.push(repo);
    expect(spawnSync(REAL_GIT, ["init", "--quiet", "-b", "main", repo]).status).toBe(0);
    expect(
      spawnSync(
        REAL_GIT,
        [
          "-c",
          "user.email=loop@example.invalid",
          "-c",
          "user.name=loop",
          "commit",
          "--allow-empty",
          "--quiet",
          "-m",
          "seed",
        ],
        { cwd: repo, encoding: "utf8" },
      ).status,
    ).toBe(0);
    const added = `${repo}-worker-b`;
    sandboxes.push(added);
    expect(
      spawnSync(
        REAL_GIT,
        [
          "-c",
          "user.email=loop@example.invalid",
          "-c",
          "user.name=loop",
          "worktree",
          "add",
          "--detach",
          "--quiet",
          added,
          "HEAD",
        ],
        { cwd: repo, encoding: "utf8" },
      ).status,
    ).toBe(0);
    // **口は本物を置く**（#227）——**`task` は `./bin/loop-check-leftovers` を呼ぶ**
    for (const name of ["task", "bin/loop-check-leftovers", "bin/loop-check-state"]) {
      const to = join(repo, name);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(join(REPO_ROOT, name), to);
      chmodSync(to, 0o755);
    }

    const done = spawnSync("./task", ["check:leftovers"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubs}:${process.env.PATH ?? ""}` },
    });
    return {
      status: done.status ?? -1,
      stderr: done.stderr,
      asked: existsSync(asked) ? readFileSync(asked, "utf8") : "",
      added,
    };
  }

  it("並べられなければ、そう言う", () => {
    const done = runTask(true);

    expect(done.stderr, "並べられなかったことを黙っている").toMatch(/作業場を並べられない/);
  });

  it("並べられなくても、自分の作業場の合否は変えない", () => {
    // **他所の事情で、こちらの合否を塗り替えない** (#186)——**身代わりの docker は
    // 「残っていない」を返す**ので、**0 のままであること。**
    const done = runTask(true);

    expect(done.status, "他所の事情で合否が変わっている").toBe(0);
  });

  it("並べた作業場を、実際に見に行く", () => {
    // **足しただけでは、判定に届いていない**（#557 のレビュー）——**`--elsewhere` を
    // 1 度も呼ばない実装でも「警告が出ない」は通る。** **訊かれた先で見る。**
    //
    // **compose の project は作業場ごと**なので、**足した worktree の名前で
    // `docker ps` が引かれていれば、その作業場を見に行っている。**
    const done = runTask(false);
    const projects = new Set(
      [...done.asked.matchAll(/com\.docker\.compose\.project=(\S+)/g)].map(
        ([, project]) => project ?? "",
      ),
    );

    // **名前の作り方は `task` が持つ**（`normalize_workspace_name`）ので、
    // **ここで組み立て直さない**（**写すと、正規化を 2 箇所に持つ**）
    // ——**見るのは「自分のぶんだけではない」ことと、足した作業場が居ること**である。
    expect(projects.size, "自分の作業場しか見に行っていない").toBeGreaterThanOrEqual(2);
    expect(
      [...projects].filter((project) => project.endsWith("-worker-b")),
      "足した作業場を見に行っていない",
    ).toHaveLength(1);
  });

  it("見つけたら、その作業場の場所を言う", () => {
    // **名前だけでは足りない** (#557 のレビュー 2 周目)——**第 3 引数に `$path` ではなく
    // `$here` を渡す退行でも、名前の側は通る。** **そのとき出るのは「別の作業場で
    // 走っています: <自分の場所>」**で、**待つ相手が特定できない**（#549 でこちらが
    // 満たした条件が、そこで消える）。
    const done = runTask(false, true);

    expect(done.stderr, "走っていることを言っていない").toContain("別の作業場で走っています");
    expect(done.stderr, "足した作業場の場所を言っていない").toContain(done.added);
  });

  it("並べられたときは、余計なことを言わない", () => {
    // **平常時に鳴る検査は読まれなくなる** (#248)
    const done = runTask(false);

    expect(done.stderr, "並べられたのに言っている").not.toMatch(/作業場を並べられない/);
  });
});

describe("bin/loop-check-leftovers --groups / --alive", () => {
  /**
   * **検出を、名前から実行木へ移す**（#574）。
   *
   * **名前で当てているかぎり、列挙のあとに fork された子は見えない**
   * ——**`sh -c pnpm lint && …` にも vitest の worker（`forks.js`）にも
   * `pnpm check` / `vitest run` は無い**ので、**親が消えて reparent されると、
   * 木辿りからも名前からも落ちる。**
   *
   * **グループなら見える。** **`setsid` しないかぎり、あとから fork された子も
   * 同じ PGID に入る**——**`docker top -eo pid,pgid,stat,cmd` で引ける。**
   *
   * **`Z` は数えない**（#572）——**親の回収を待っているだけ**である。
   */
  const sandboxes: string[] = [];

  afterEach(() => {
    for (const dir of sandboxes.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function withDocker(top: string[]): (args: string[]) => {
    status: number;
    stdout: string;
    stderr: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), "leftover-groups-"));
    sandboxes.push(dir);
    writeFileSync(
      join(dir, "docker"),
      [
        "#!/usr/bin/env bash",
        'if [[ $1 == "ps" ]]; then printf "%s\\n" abc123; exit 0; fi',
        'if [[ $1 == "top" ]]; then',
        `  printf '%s\\n' ${top.map((line) => JSON.stringify(line)).join(" ")}`,
        "  exit 0",
        "fi",
        "exit 2",
      ].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(join(dir, "docker"), 0o755);
    return (args) => {
      const result = spawnSync(SCRIPT, args, {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      });
      return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
    };
  }

  it("走りのグループを出す", () => {
    const run = withDocker([
      HEADER,
      "9129 9124 Sl node /usr/local/bin/pnpm dev",
      "100 100 Sl node /usr/local/bin/pnpm check",
      "101 100 S sh -c pnpm lint && pnpm typecheck",
    ]);
    const found = run(["--groups", "valence"]);

    expect(found.status).toBe(1);
    expect(found.stdout.trim().split("\n")).toEqual(["100"]);
  });

  it("`pnpm dev` のグループは出さない", () => {
    // **巻き込むと開発サーバが落ちる**
    const run = withDocker([HEADER, "9129 9124 Sl node /usr/local/bin/pnpm dev"]);

    expect(run(["--groups", "valence"]).status).toBe(0);
  });

  it("`./task test:watch` のグループも出さない", () => {
    // **数えない規則は 1 箇所のまま**である（#529）
    const run = withDocker([HEADER, "200 200 Sl node /usr/local/bin/pnpm test:watch"]);

    expect(run(["--groups", "valence"]).status).toBe(0);
  });

  it("列挙のあとに fork された子を、グループから見つける", () => {
    // **この Issue そのもの**である——**親（`pnpm check`）は消え、
    // 残っているのは名前に当たらない worker だけ。** **名前では見えない。**
    const run = withDocker([
      HEADER,
      "102 100 Sl node /home/x/node_modules/vitest/dist/workers/forks.js",
    ]);
    const found = run(["--alive", "valence", "100"]);

    expect(found.status, "グループに残っているのに 0 を返している").toBe(1);
    expect(found.stdout, "何が残っているかが出ない").toContain("102");
  });

  it("`Z` は残っていると数えない", () => {
    // **親の回収を待っているだけ**である（#572 で測った側）
    const run = withDocker([HEADER, "102 100 Z node /home/x/…/forks.js <defunct>"]);

    expect(run(["--alive", "valence", "100"]).status).toBe(0);
  });

  it("別のグループは数えない", () => {
    // **落としたグループのぶんだけを見る**
    const run = withDocker([HEADER, "9129 9124 Sl node /usr/local/bin/pnpm dev"]);

    expect(run(["--alive", "valence", "100"]).status).toBe(0);
  });

  it("読めなければ、判定できないと言う", () => {
    const dir = mkdtempSync(join(tmpdir(), "leftover-groups-fail-"));
    sandboxes.push(dir);
    writeFileSync(
      join(dir, "docker"),
      '#!/usr/bin/env bash\nif [[ $1 == "ps" ]]; then printf "%s\\n" abc123; exit 0; fi\nexit 1\n',
      { mode: 0o755 },
    );
    chmodSync(join(dir, "docker"), 0o755);
    const result = spawnSync(SCRIPT, ["--alive", "valence", "100"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
    });

    expect(result.status).toBe(2);
  });
});
