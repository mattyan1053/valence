import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./db-config-drift", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

type Run = { status: number; stdout: string; stderr: string };

/** 起動時に置換された値。**試験の中でだけ使う**（本物には近づかない）。 */
const STARTED_WITH = "started-value-8f2a";
const EDITED_TO = "edited-value-b41c";

describe("bin/db-config-drift", () => {
  let repo: string;
  let path: string;

  /**
   * 走っているコンテナを偽る `docker`。
   *
   * **実物へは触らない** (`AGENTS.md` §5)。**落として上げ直す形で確かめると、
   * 走っているものと競る**——**#186 の確認手順が、配られた `loop/STOP` を消した**。
   */
  function withDocker(
    running: { name: string; id: string }[],
    options: { fails?: boolean } = {},
  ): void {
    const rows = running.map(({ name, id }) => `${name}:${id}`).join("\n");
    writeFileSync(
      join(path, "docker"),
      [
        "#!/usr/bin/env bash",
        ...(options.fails === true ? ["exit 1"] : []),
        // **`--filter name=` は部分一致**なので、**本物と同じく正規表現で照合する**
        // ——**別プロジェクトの Supabase を拾わないこと**を、ここで試せるようにする
        'pattern=""',
        'for arg in "$@"; do case $arg in name=*) pattern="${arg#name=}" ;; esac; done',
        `rows=${JSON.stringify(rows)}`,
        "[[ -n $rows ]] || exit 0",
        "while IFS=: read -r name id; do",
        "  [[ -n $name ]] || continue",
        "  [[ $name =~ $pattern ]] && printf '%s\\n' \"$id\"",
        'done <<<"$rows"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
  }

  function writeEnv(values: Record<string, string>): void {
    const lines = Object.entries(values).map(([name, value]) => `${name}=${value}`);
    writeFileSync(join(repo, ".env"), `${lines.join("\n")}\n`);
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

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "db-config-drift-"));
    expect(spawnSync("git", ["init", "--quiet", repo]).status).toBe(0);
    path = join(repo, "path");
    mkdirSync(path, { recursive: true });
    // **`sha256sum` は置かない** (#282 のレビュー 2 周目)。**このスクリプトはホストで走る**
    // ので、**GNU coreutils を前提にすると `./task db:up` ごと落ちる**（`AGENTS.md` §2。
    // #220 の `flock` と同じ形）——**指紋は `git hash-object` で取る**（`git` は既に必須）。
    // **一覧から外すことが、そのまま試験になっている**（要れば全部が落ちる）
    for (const command of ["bash", "git", "grep", "cat", "rm", "mv"]) {
      const found = spawnSync("which", [command], { encoding: "utf8" }).stdout.trim();
      if (found !== "") {
        spawnSync("ln", ["-s", found, join(path, command)]);
      }
    }
    chmodSync(path, 0o755);

    mkdirSync(join(repo, "supabase"), { recursive: true });
    writeFileSync(
      join(repo, "supabase", "config.toml"),
      [
        // **コンテナの名前はここから決まる**（`supabase_db_valence`）
        'project_id = "valence"',
        "[auth.external.github]",
        'client_id = "env(GITHUB_APP_CLIENT_ID)"',
        // **コメント行は置換されない。** 見に行くと、**触っていない変数で毎回鳴る**
        '# secret_key = "env(SECRET_VALUE)"',
        "",
      ].join("\n"),
    );
    writeEnv({ GITHUB_APP_CLIENT_ID: STARTED_WITH, SECRET_VALUE: "unused" });
    withDocker([{ name: "supabase_db_valence", id: "c1" }]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("起動したときと同じなら、何も言わない", () => {
    // **毎回鳴る警告にしない** (#248 と同じ判断)。**正常な状態で鳴るものは読まれなくなる**
    expect(run("record").status).toBe(0);

    const checked = run("check");

    expect(checked.status).toBe(0);
    expect(checked.stdout).toBe("");
  });

  it("起動したあとに .env を書き換えたら、その変数の名前を出す", () => {
    // **これが本題。** **`config.toml` の `env()` は `supabase start` の瞬間にしか
    // 置換されない**ので、**あとから直しても走っているコンテナには入らない**
    // （5 日間、古い値で走っていたのに誰にも見えなかった）
    expect(run("record").status).toBe(0);
    writeEnv({ GITHUB_APP_CLIENT_ID: EDITED_TO, SECRET_VALUE: "unused" });

    const checked = run("check");

    expect(checked.status).toBe(1);
    expect(checked.stdout).toContain("GITHUB_APP_CLIENT_ID");
  });

  it("出すのは名前まで。値は出さない", () => {
    // **§6。** **`docker compose config` のように環境変数を平文で吐くものがある**——
    // **どちらの値も出さない**（**古いほうも秘密である**）
    expect(run("record").status).toBe(0);
    writeEnv({ GITHUB_APP_CLIENT_ID: EDITED_TO, SECRET_VALUE: "unused" });

    const checked = run("check");

    expect(`${checked.stdout}${checked.stderr}`).not.toContain(STARTED_WITH);
    expect(`${checked.stdout}${checked.stderr}`).not.toContain(EDITED_TO);
  });

  it("記録にも値を残さない", () => {
    // **記録は共有ディレクトリに残る**ので、**そこに平文があれば同じこと**である
    run("record");
    const record = readFileSync(join(repo, ".git", "valence-db-config"), "utf8");

    expect(record).toContain("GITHUB_APP_CLIENT_ID");
    expect(record).not.toContain(STARTED_WITH);
  });

  it("直し方も出す", () => {
    // **気づいても直し方が分からないと、同じ時間を使う**
    run("record");
    writeEnv({ GITHUB_APP_CLIENT_ID: EDITED_TO, SECRET_VALUE: "unused" });

    expect(run("check").stdout).toContain("./task db:down && ./task db:up");
  });

  it("コメント行の env() は見ない", () => {
    // **置換されないものを見ると、触っていない変数で毎回鳴る**
    run("record");
    writeEnv({ GITHUB_APP_CLIENT_ID: STARTED_WITH, SECRET_VALUE: "changed" });

    expect(run("check").status).toBe(0);
  });

  it("コンテナが走っていなければ、何も言わない", () => {
    // **古いまま走っているものが無い**ので、**言うことは無い**——
    // **CI や、まだ起動していない手元で毎回鳴らせない**
    run("record");
    writeEnv({ GITHUB_APP_CLIENT_ID: EDITED_TO, SECRET_VALUE: "unused" });
    withDocker([]);

    const checked = run("check");

    expect(checked.status).toBe(0);
    expect(checked.stdout).toBe("");
  });

  it("docker が無ければ、走っていないものとして黙る", () => {
    // **入っていない機械もある。** **そこで毎回鳴らせない**
    rmSync(join(path, "docker"));
    run("record");
    writeEnv({ GITHUB_APP_CLIENT_ID: EDITED_TO, SECRET_VALUE: "unused" });

    expect(run("check").status).toBe(0);
  });

  it("記録が無いまま走っていたら、分からないと言う", () => {
    // **前の版で起動したコンテナ**である。**黙ると、この Issue が塞ぎに来た状態**
    // （**古い値で走っているのに誰も知らない**）**がそのまま残る**——
    // **「違う」ではなく「分からない」と言う**（次の起動で消える）
    const checked = run("check");

    expect(checked.status).toBe(1);
    expect(checked.stdout).toContain("./task db:down && ./task db:up");
  });

  it("既に走っているところで控え直さない", () => {
    // **これが本題** (#282 のレビュー)。**`supabase start` は既に走っていても成功する**
    // ——**そのときコンテナは作り直されない**のに、**控え直すと記録だけ新しくなる。**
    // **`.env` を直した人が `db:up` を打つと、中身は古いまま「一致」と答える**
    // ——**この Issue が塞ぎに来た状態が、恒久的に隠れる。**
    run("record");
    writeEnv({ GITHUB_APP_CLIENT_ID: EDITED_TO, SECRET_VALUE: "unused" });

    // 走っているのは、控えたときと同じスタック（`c1`）である
    expect(run("record", "--unless", "c1").status).toBe(0);

    expect(run("check").status, "食い違いが隠れている").toBe(1);
  });

  it("本当に起動し直したときは控える", () => {
    run("record");
    writeEnv({ GITHUB_APP_CLIENT_ID: EDITED_TO, SECRET_VALUE: "unused" });
    // 落として上げ直したので、スタックが入れ替わっている
    withDocker([{ name: "supabase_db_valence", id: "c2" }]);

    expect(run("record", "--unless", "c1").status).toBe(0);

    expect(run("check").status).toBe(0);
  });

  it("起動したか分からないなら控えない", () => {
    // **判定できないなら控えない**——**倒れる向きが安全**である
    run("record");
    writeEnv({ GITHUB_APP_CLIENT_ID: EDITED_TO, SECRET_VALUE: "unused" });
    withDocker([{ name: "supabase_db_valence", id: "c2" }], { fails: true });

    run("record", "--unless", "c1");

    withDocker([{ name: "supabase_db_valence", id: "c2" }]);
    expect(run("check").status, "分からないまま控えている").toBe(1);
  });

  it("別のプロジェクトの Supabase は拾わない", () => {
    // **`--filter name=` は部分一致**なので、**別プロジェクトが走っているだけで
    // 誤警告する**（**記録があれば、存在しないスタックと比べる**）
    run("record");
    writeEnv({ GITHUB_APP_CLIENT_ID: EDITED_TO, SECRET_VALUE: "unused" });
    withDocker([{ name: "supabase_db_other", id: "z9" }]);

    expect(run("check").status).toBe(0);
  });

  it("stack-id は、走っているスタックだけに答える", () => {
    const running = run("stack-id");

    expect(running.status).toBe(0);
    expect(running.stdout.trim()).toBe("c1");

    withDocker([{ name: "supabase_db_other", id: "z9" }]);

    expect(run("stack-id").status, "別プロジェクトを自分のものと答えている").toBe(1);
  });

  it("記録にだけ残っている変数も、食い違いとして数える", () => {
    // **`config.toml` から `env(...)` を消した／コメントアウトした**とき、
    // **走っているコンテナには消したはずの設定が生きたまま**である
    // ——**いまの名前だけを走査すると、記録にしか無い名前が差分から落ちる**
    run("record");
    writeFileSync(
      join(repo, "supabase", "config.toml"),
      ['project_id = "valence"', "[auth.external.github]", ""].join("\n"),
    );

    const checked = run("check");

    expect(checked.status).toBe(1);
    expect(checked.stdout).toContain("GITHUB_APP_CLIENT_ID");
  });

  it("使い方の誤りは 2 で落ちる", () => {
    expect(run("").status).toBe(2);
    expect(run("checkk").status).toBe(2);
  });

  /**
   * `db:up` を、**本物の `task` の関数として**走らせる。
   *
   * **`task` を写経しない。** **写した側だけが古くなる**ので、**実物をコピーして
   * `source` し、外から見えるところ（`bin/db-config-drift` の呼ばれ方）だけを見る。**
   */
  function runDbUp(stackId: { out: string; status: number }): string {
    const box = join(repo, "box");
    mkdirSync(join(box, "bin"), { recursive: true });
    writeFileSync(join(box, "task"), readFileSync(join(REPO_ROOT, "task"), "utf8"), {
      mode: 0o755,
    });
    const log = join(box, "calls.log");
    writeFileSync(
      join(box, "bin", "db-config-drift"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >>${JSON.stringify(log)}`,
        'if [[ $1 == "stack-id" ]]; then',
        `  printf '%s' ${JSON.stringify(stackId.out)}`,
        `  exit ${stackId.status}`,
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(log, "");
    const result = spawnSync(
      "bash",
      [
        "-c",
        // **起動そのものは差し替える。** **実物のコンテナへは触らない**（§5）
        `source ./task >/dev/null 2>&1; ensure_up() { :; }; supabase_cli() { :; }; db_up`,
      ],
      { cwd: box, encoding: "utf8", timeout: 20_000 },
    );
    expect(result.status, `db_up が落ちた: ${result.stderr}`).toBe(0);
    return readFileSync(log, "utf8");
  }

  it("db:up は、起動前のスタックを見て record へ渡す", () => {
    expect(runDbUp({ out: "c1", status: 0 })).toContain("record --unless c1");
  });

  it("db:up は、停まっていたことも record へ渡す", () => {
    // **停まっていた**＝**この `supabase start` が本当に起動した**ので、控えてよい
    expect(runDbUp({ out: "", status: 1 })).toContain("record --unless");
  });

  it("db:up は、起動前を読めなかったら控えさせない", () => {
    // **これが本題** (#282 のレビュー 2 周目)。**`stack-id` は「停まっている」(1) と
    // 「読めない」(2) を分けている**のに、**呼ぶ側が両方を空文字へ潰す**と、
    // **前だけ `docker ps` が落ちて後で復旧したとき**、**「already running」の成功のあとに
    // 実在の ID が空文字と食い違い、`record` が上書きする**——
    // **スクリプト側で塞いだ穴が、呼ぶ側から開く。**
    expect(runDbUp({ out: "", status: 2 })).not.toContain("record");
  });

  it("./task が、毎回通る場所で check を、db:up で record を通す", () => {
    // **別のコマンドを覚えさせない**（Issue の「やること」）。**呼ぶ場所を散文で
    // 並べると、経路が増えたときに漏れる**ので、**呼び出しの存在をここで押さえる**
    const task = readFileSync(join(REPO_ROOT, "task"), "utf8");
    // **呼ぶ側と、呼ばれる側の両方を見る。** **片方だけだと、
    // 「関数はあるが誰も呼んでいない」「呼んでいるが中身が空」を通す**（#176 の形）
    const main = task.slice(task.indexOf("\nmain() {"));
    const caller = (/\nmain\(\) \{[\s\S]*?\n\}/.exec(task)?.[0] ?? "").match(/^ +(\w+)$/gm) ?? [];
    const called = caller.map((line) => line.trim());
    const checker = called.find((name) => {
      const body = new RegExp(`\\n${name}\\(\\) \\{[\\s\\S]*?\\n\\}`).exec(task)?.[0] ?? "";
      return body.includes("db-config-drift check");
    });

    expect(main, "main を読めていない").toContain("heartbeat");
    expect(checker, "毎回通る場所から check を呼んでいない").toBeDefined();
    // **`--unless` を渡していること**まで見る (#282 のレビュー)。**渡さないと、
    // 既に走っているところで控え直し、食い違いが恒久的に隠れる**
    expect(task, "db:up で record を通していない").toMatch(/db-config-drift record --unless/);
  });
});
