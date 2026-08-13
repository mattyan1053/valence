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
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * **作業場が増えても、互いを壊さないこと**（#82）。
 *
 * **見るのは「2 つ作れる」ではない。** **同時に動いたときに、同じ compose project と
 * 同じポートを掴まないこと**である——**掴めば、後から起きたほうが相手のコンテナを
 * 作り直す**（`compose.yaml` は `name` と port を固定していた）。
 *
 * **「2 人で動いた」と「N 人で衝突しない」は別の主張である**（#99 の教訓）。
 * **ここが主張するのは後者**——**名前が違えば、project もポートも必ず違う。**
 */
describe("作業場ごとに、compose project とポートを分ける", () => {
  let roots: string[] = [];

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
    roots = [];
  });

  /** `task` だけを置いた作業場。**docker は偽物**にして、何を頼んだかだけ記録する。 */
  function workspace(name: string): { dir: string; log: string } {
    const parent = mkdtempSync(join(tmpdir(), "worker-workspaces-"));
    roots.push(parent);
    const dir = join(parent, name);
    mkdirSync(dir);
    copyFileSync(join(REPO_ROOT, "task"), join(dir, "task"));
    chmodSync(join(dir, "task"), 0o755);
    copyFileSync(join(REPO_ROOT, "compose.yaml"), join(dir, "compose.yaml"));
    const stub = join(dir, "stub");
    mkdirSync(stub);
    const log = join(dir, "docker.log");
    writeFileSync(
      join(stub, "docker"),
      `#!/usr/bin/env bash\nprintf 'port=%s args=%s\\n' "\${VALENCE_APP_PORT:-未設定}" "$*" >> ${JSON.stringify(log)}\nexit 0\n`,
      { mode: 0o755 },
    );
    return { dir, log };
  }

  function up(dir: string, stubDir = join(dir, "stub")): void {
    const result = spawnSync("./task", ["up"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ""}` },
    });
    expect(result.status, result.stderr).toBe(0);
  }

  /** 頼んだ project 名（`compose -p <名前>`）。 */
  function projectIn(log: string): string {
    const found = /args=compose -p (\S+)/.exec(readFileSync(log, "utf8"));
    expect(found, `project を指定していない: ${readFileSync(log, "utf8")}`).not.toBeNull();
    return found?.[1] ?? "";
  }

  /** 頼んだポート（`VALENCE_APP_PORT`）。 */
  function portIn(log: string): string {
    const found = /port=(\S+) args=compose -p/.exec(readFileSync(log, "utf8"));
    return found?.[1] ?? "";
  }

  it("名前が違えば、project もポートも違う", () => {
    // **N 人で衝突しないことを見る。** 2 つだけだと「たまたま違った」と区別が付かない
    const names = [
      "valence",
      "valence-worker-a",
      "valence-worker-b",
      "valence-worker-c",
      "valence-master",
    ];
    const seen = names.map((name) => {
      const { dir, log } = workspace(name);
      up(dir);
      return { name, project: projectIn(log), port: portIn(log) };
    });

    expect(new Set(seen.map((one) => one.project)).size, "project が重なっている").toBe(
      names.length,
    );
    expect(new Set(seen.map((one) => one.port)).size, "ポートが重なっている").toBe(names.length);
  });

  it("同じ作業場なら、いつ動かしても同じ値になる", () => {
    // **空きを探して割り当てない**（起動のたびに変わると人が繋ぎ直せない）
    const { dir, log } = workspace("valence-worker-a");

    up(dir);
    up(dir);

    // **compose を呼んだ行だけを見る**（network の用意は毎回同じで、主題ではない）
    const asked = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.includes("args=compose"));

    expect(asked).toHaveLength(2);
    expect(asked[0]).toBe(asked[1]);
  });

  it("compose が受け付ける project 名にする", () => {
    // **`docker compose` は project 名を「小文字英数字・ハイフン・アンダースコアで、
    // 英数字から始まる」に限る**（#195 のレビュー 2 周目で実測）。**`compose.yaml` が
    // `name:` を持っていた間は clone 先に依存しなかった**——**この PR が入れて初めて
    // 壊れる**。**`compose()` は入口**なので、**`Valence/` へ clone した人は
    // `./task` が 1 つも通らない**（`sha256sum` と同じ場所・同じ落ち方）
    const { dir, log } = workspace("Valence.Fork");

    up(dir);

    expect(projectIn(log), "compose が弾く名前を渡している").toMatch(/^[a-z0-9][a-z0-9_-]*$/);
  });

  it("正規化した名前が、project にもポートにも使われる", () => {
    // **片方だけ正規化すると、`-p` は `valence` なのにポートは `Valence` の digest
    // から決まる**——**「同じ project は同じポート」が崩れる**（#195 のレビュー 2 周目）
    const upper = workspace("Valence");
    const lower = workspace("valence");

    up(upper.dir);
    up(lower.dir);

    expect(projectIn(upper.log)).toBe(projectIn(lower.log));
    expect(portIn(upper.log), "project は同じなのにポートが違う").toBe(portIn(lower.log));
  });

  it("既定の 1 人運用は、これまでどおり", () => {
    // **設定を足さなくても壊れない。** `valence` は project も port も動かさない
    const { dir, log } = workspace("valence");

    up(dir);

    expect(projectIn(log)).toBe("valence");
    expect(portIn(log)).toBe("3000");
  });

  it("2 つ同時に動いても、掴む先が重ならない", () => {
    // **本題。** **同じ project を掴むと、後から起きたほうが相手のコンテナを作り直す**
    const first = workspace("valence-worker-a");
    const second = workspace("valence-worker-b");

    const both = spawnSync(
      "bash",
      [
        "-c",
        `cd ${JSON.stringify(first.dir)} && PATH=${JSON.stringify(join(first.dir, "stub"))}:$PATH ./task up & ` +
          `cd ${JSON.stringify(second.dir)} && PATH=${JSON.stringify(join(second.dir, "stub"))}:$PATH ./task up & ` +
          "wait",
      ],
      { encoding: "utf8" },
    );
    expect(both.status, both.stderr).toBe(0);

    expect(projectIn(first.log)).not.toBe(projectIn(second.log));
    expect(portIn(first.log)).not.toBe(portIn(second.log));
  });
});

/**
 * **作業場を増やす／減らす**（#82）。
 *
 * **人数を前提にしない。** 「2 人目」を特別扱いすると 3 人目で作り直しになるので、
 * **名前で増やす**。**名前が識別子**なので、**重複は誤り**である。
 */
describe("./task loop:worker:add / remove", () => {
  let roots: string[] = [];

  afterEach(() => {
    for (const root of roots) {
      // worktree の登録ごと消す（親を消すだけだと prune されない）
      const repo = join(root, "valence");
      spawnSync("git", ["-C", repo, "worktree", "prune"], { encoding: "utf8" });
      rmSync(root, { recursive: true, force: true });
    }
    roots = [];
  });

  /** 本物の `task` を持つ使い捨てリポジトリ。**docker は偽物**にする。 */
  function repo(): { dir: string; log: string; env: NodeJS.ProcessEnv } {
    const parent = mkdtempSync(join(tmpdir(), "worker-add-"));
    roots.push(parent);
    const dir = join(parent, "valence");
    mkdirSync(dir);
    expect(spawnSync("git", ["init", "--quiet", dir]).status).toBe(0);
    copyFileSync(join(REPO_ROOT, "task"), join(dir, "task"));
    chmodSync(join(dir, "task"), 0o755);
    spawnSync("git", ["-C", dir, "add", "-A"]);
    spawnSync("git", [
      "-C",
      dir,
      "-c",
      "user.email=loop@example.invalid",
      "-c",
      "user.name=loop",
      "commit",
      "--quiet",
      "-m",
      "init",
    ]);
    const stub = join(dir, "stub");
    mkdirSync(stub);
    const log = join(dir, "docker.log");
    writeFileSync(
      join(stub, "docker"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`,
      { mode: 0o755 },
    );
    return { dir, log, env: { ...process.env, PATH: `${stub}:${process.env.PATH ?? ""}` } };
  }

  function task(dir: string, env: NodeJS.ProcessEnv, args: string[]) {
    return spawnSync("./task", args, { cwd: dir, encoding: "utf8", env });
  }

  it("名前ごとに作業場ができる", () => {
    const { dir, env } = repo();

    const added = task(dir, env, ["loop:worker:add", "a"]);

    expect(added.status, added.stderr).toBe(0);
    const registered = spawnSync("git", ["-C", dir, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    }).stdout;
    expect(registered).toContain(`${dir}-worker-a`);
  });

  it("同じ名前で 2 度目は失敗する", () => {
    // **名前が識別子**なので、**重複は誤り**である
    const { dir, env } = repo();
    expect(task(dir, env, ["loop:worker:add", "a"]).status).toBe(0);

    const again = task(dir, env, ["loop:worker:add", "a"]);

    expect(again.status, "同じ名前を通している").not.toBe(0);
  });

  it("ポートが既にある作業場と重なる名前は、足す前に失敗する", () => {
    // **N 人で衝突しないことを、確率に任せない。** 名前は決定論的にポートへ写るので、
    // **別の名前が同じポートへ落ちることはある**（`nn` と `pk` は、どちらも 3002）。
    //
    // **足したあとに `up` が「アドレス使用中」で落ちる形にしない**——
    // **落ちるのは 2 人目が動き出したときで、原因が名前だと分からない**。
    //
    // **数字を書き写していない。本物に探させた**（写す先が変われば、また探す）。
    //
    // ---8<--- 衝突する名前の探し方 ---
    //   source ./task >/dev/null 2>&1
    //   for a in {a..z} {a..z}{a..z}; do
    //     printf '%s\t%s\n' "$a" "$(workspace_port "valence-worker-$a")"
    //   done | sort -k2,2n |
    //     awk -F'\t' '{ if ($2 == p) { print pn, $1, $2; exit }; p = $2; pn = $1 }'
    // ---8<--- ここまで ---
    const { dir, env } = repo();
    expect(task(dir, env, ["loop:worker:add", "nn"]).status).toBe(0);

    const clash = task(dir, env, ["loop:worker:add", "pk"]);

    expect(clash.status, "同じポートへ落ちる名前を通している").not.toBe(0);
    expect(`${clash.stdout}${clash.stderr}`, "何と衝突したのかが出ていない").toContain("nn");
  });

  it("他の作業場のポートを読めなければ、足さない", () => {
    // **「読めない」を「衝突なし」に倒さない**（#195 のレビュー）。**倒すと、
    // 読めなかっただけで足してしまい、2 人目が動き出したときに初めて落ちる**
    const { dir, env } = repo();
    expect(task(dir, env, ["loop:worker:add", "a"]).status).toBe(0);
    // **2 回目の digest だけ落とす。** 1 回目は足そうとしている名前ぶんで、
    // **落としたいのは「既にある作業場を読む」ほう**である
    const real = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(
      join(dir, "stub", "git"),
      [
        "#!/usr/bin/env bash",
        'if [[ $1 == "hash-object" ]]; then',
        `  count="$(cat ${JSON.stringify(join(dir, "hash.count"))} 2>/dev/null || echo 0)"`,
        `  printf '%s' "$((count + 1))" > ${JSON.stringify(join(dir, "hash.count"))}`,
        "  if ((count + 1 >= 2)); then echo '読めない' >&2; exit 1; fi",
        "fi",
        `exec ${JSON.stringify(real)} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const added = task(dir, env, ["loop:worker:add", "b"]);

    expect(added.status, "読めていないのに足している").not.toBe(0);
    expect(existsSync(`${dir}-worker-b`), "作業場ができている").toBe(false);
  });

  it("master の作業場と同じポートへ落ちる名前は、まだ作られていなくても弾く", () => {
    // **`cmd_loop_setup` は検査を 1 つも持たない**（#195 のレビュー 2 周目）。
    // **`add` を先に、`loop:setup` を後に打つと、master が同じポートで作られる**——
    // **1 人で、順番に踏める**（同時実行の競合とは別物である）。
    //
    // **登録の有無で見ない。** **`${PWD}-master` は予約**として扱う——
    // **setup 以外の経路で作られても効く**。
    //
    // ---8<--- master と衝突する名前の探し方 ---
    //   source ./task >/dev/null 2>&1
    //   m="$(workspace_port valence-master)"
    //   for a in {a..z}{a..z}{a..z}; do
    //     [[ "$(workspace_port "valence-worker-$a")" == "$m" ]] && { echo "$a"; break; }
    //   done
    // ---8<--- ここまで ---
    const { dir, env } = repo();

    const clash = task(dir, env, ["loop:worker:add", "cgo"]);

    expect(clash.status, "master と同じポートへ落ちる名前を通している").not.toBe(0);
    expect(`${clash.stdout}${clash.stderr}`, "何と衝突したのかが出ていない").toContain("master");
  });

  it("worktree の一覧を取れなければ、足さない", () => {
    // **プロセス置換の中の終了コードは、呼び出し側に伝わらない**——
    // **落ちるとループが 0 回回り、「衝突なし」と同じ見え方になる**（#190 と同じ形）
    const { dir, env } = repo();
    const real = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(
      join(dir, "stub", "git"),
      [
        "#!/usr/bin/env bash",
        'if [[ $1 == "worktree" && $2 == "list" ]]; then echo "壊れている" >&2; exit 1; fi',
        `exec ${JSON.stringify(real)} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const added = task(dir, env, ["loop:worker:add", "a"]);

    expect(added.status, "一覧を取れていないのに足している").not.toBe(0);
    expect(existsSync(`${dir}-worker-a`), "作業場ができている").toBe(false);
  });

  it("remove で、作業場もコンテナも残らない", () => {
    const { dir, log, env } = repo();
    expect(task(dir, env, ["loop:worker:add", "a"]).status).toBe(0);

    const removed = task(dir, env, ["loop:worker:remove", "a"]);

    expect(removed.status, removed.stderr).toBe(0);
    const registered = spawnSync("git", ["-C", dir, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    }).stdout;
    expect(registered, "worktree が残っている").not.toContain(`${dir}-worker-a`);
    expect(readFileSync(log, "utf8"), "コンテナを落としていない").toContain(
      `compose -p ${basename(dir)}-worker-a down`,
    );
  });

  it("未コミットの変更があれば、remove は消さずに止まる", () => {
    // **`--force` は「dirty でも locked でも消す」**である。**worker の作業場は
    // ほぼ常に dirty** なので、**commit していない実装が確認なしに消える。戻せない。**
    //
    // **`up` が落ちるのは、少なくとも落ちる。消えた実装は、消えたことすら出ない。**
    const { dir, log, env } = repo();
    expect(task(dir, env, ["loop:worker:add", "a"]).status).toBe(0);
    writeFileSync(join(`${dir}-worker-a`, "まだ commit していない.txt"), "しごとの途中\n");

    const removed = task(dir, env, ["loop:worker:remove", "a"]);

    expect(removed.status, "dirty な作業場を消している").not.toBe(0);
    expect(existsSync(`${dir}-worker-a`), "作業場が消えている").toBe(true);
    expect(`${removed.stdout}${removed.stderr}`, "どうすればよいかが出ていない").toContain(
      "--force",
    );
    expect(readFileSync(log, "utf8"), "コンテナだけ落として作業場を残している").toContain("down");
  });

  it("知らない名前を remove しても、黙って成功しない", () => {
    const { dir, env } = repo();

    const missing = task(dir, env, ["loop:worker:remove", "いない"]);

    expect(missing.status, "無い作業場を消したことにしている").not.toBe(0);
  });
});
