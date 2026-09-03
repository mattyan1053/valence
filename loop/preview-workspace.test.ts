/**
 * **人が開く画面を、worker の作業場から分ける**（#457）。
 *
 * **`compose.yaml` は `${PWD}` をマウントして `next dev` を回す**ので、**人が開くと
 * worker の作業ツリーがそのまま映る**——**未コミットの実装途中が出る**うえ、
 * **`origin/main` へ追随するのは周回の冒頭だけ**なので、**マージ済みの修正は
 * worker が周回するまで映らない。**
 *
 * **実測（2026-08-24）**: **#453 が 13:49 にログインを直したのに、100 分後に人が
 * 開いても直っていなかった**——**人は「まだ壊れている」と読む。**
 *
 * **見るのは「作れる」ではない。** **`origin/main` を映すこと**、**いつの main かが
 * 分かること**、**worker の一覧に混ざらないこと**である。
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("./task loop:preview", () => {
  let roots: { parent: string; dir: string }[] = [];

  afterEach(() => {
    for (const { parent, dir } of roots) {
      spawnSync("git", ["-C", dir, "worktree", "prune"], { encoding: "utf8" });
      rmSync(parent, { recursive: true, force: true });
    }
    roots = [];
  });

  function git(dir: string, args: string[]): string {
    const ran = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    expect(ran.status, `git ${args.join(" ")}: ${ran.stderr}`).toBe(0);
    return ran.stdout.trim();
  }

  /**
   * 本物の `task` を持つ使い捨てリポジトリ。**`origin` も本物**（bare）にする。
   *
   * **`origin/main` を映すことが主題**なので、**取ってくる先が無いと何も見えない。**
   */
  function repo(name = "valence"): { dir: string; origin: string; env: NodeJS.ProcessEnv } {
    const parent = mkdtempSync(join(tmpdir(), "preview-workspace-"));
    const dir = join(parent, name);
    roots.push({ parent, dir });
    mkdirSync(dir);
    expect(spawnSync("git", ["init", "--quiet", "--initial-branch=main", dir]).status).toBe(0);
    copyFileSync(join(REPO_ROOT, "task"), join(dir, "task"));
    chmodSync(join(dir, "task"), 0o755);
    git(dir, ["add", "-A"]);
    git(dir, [
      "-c",
      "user.email=loop@example.invalid",
      "-c",
      "user.name=loop",
      "commit",
      "--quiet",
      "-m",
      "init",
    ]);
    const origin = join(parent, "origin.git");
    expect(
      spawnSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]).status,
    ).toBe(0);
    git(dir, ["remote", "add", "origin", origin]);
    git(dir, ["push", "--quiet", "origin", "main"]);
    git(dir, ["fetch", "--quiet", "origin", "main"]);
    const stub = join(dir, "stub");
    mkdirSync(stub);
    // **何を打ったかを残す** (#495)。**温めはコンテナの中で走る**ので、**ホスト側から
    // 見えるのは `docker` への呼び出しだけ**である——**そこを記録して突き合わせる。**
    //
    // **`exec` だけは落とせるようにする**（`warm.fail` に回数を書く）——**温めが
    // 落ちても `up` は成功する**、を実際に走らせて見るため。
    writeFileSync(
      join(stub, "docker"),
      [
        "#!/usr/bin/env bash",
        `log=${JSON.stringify(join(dir, "docker.log"))}`,
        `fails=${JSON.stringify(join(dir, "warm.fail"))}`,
        `state=${JSON.stringify(join(dir, "warm.count"))}`,
        'printf "%s\\n" "$*" >>"$log"',
        `hang=${JSON.stringify(join(dir, "warm.hang"))}`,
        'if [[ $* == *" exec "* ]]; then',
        '  count=$(( $(cat "$state" 2>/dev/null || echo 0) + 1 ))',
        '  printf "%s" "$count" >"$state"',
        // **返らない相手** (#496 のレビュー)。**渡された上限ぶん黙ってから落ちる**
        // ——**組み立てが詰まる・SSR が返らない**、を置く。**20 秒で頭打ちにする**のは
        // **試験を待たせないため**で、**判定に使うのはそこではない。**
        "  if [[ -f $hang ]]; then",
        '    all="$*"; ms="${all##*WARM_REQUEST_MS=}"; ms="${ms%% *}"',
        "    sec=$(( ms / 1000 )); (( sec < 20 )) || sec=20",
        '    sleep "$sec"',
        "    exit 1",
        "  fi",
        '  (( count > $(cat "$fails" 2>/dev/null || echo 0) )) || exit 1',
        "fi",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    return { dir, origin, env: { ...process.env, PATH: `${stub}:${process.env.PATH ?? ""}` } };
  }

  function task(dir: string, env: NodeJS.ProcessEnv, args: string[]) {
    return spawnSync("./task", args, { cwd: dir, encoding: "utf8", env });
  }

  /**
   * **`origin/main` だけを進める**（作業場は置いていかれる）。
   *
   * **これが #457 の形**である——**worker の作業場は周回の冒頭でしか追随しない**ので、
   * **マージ済みの commit が、作業場より先にある時間**がある。**返すのは新しい commit。**
   */
  function advanceOrigin(dir: string, origin: string, note: string): string {
    const ahead = join(mkdtempSync(join(tmpdir(), "preview-ahead-")), "ahead");
    expect(spawnSync("git", ["clone", "--quiet", origin, ahead]).status).toBe(0);
    writeFileSync(join(ahead, `${note}.txt`), `${note}\n`);
    git(ahead, ["add", "-A"]);
    git(ahead, [
      "-c",
      "user.email=loop@example.invalid",
      "-c",
      "user.name=loop",
      "commit",
      "--quiet",
      "-m",
      note,
    ]);
    git(ahead, ["push", "--quiet", "origin", "main"]);
    // **作業場は移さない。** **`origin/main` の ref だけを取ってくる**（周回の冒頭より前）
    git(dir, ["fetch", "--quiet", "origin", "main"]);
    return git(ahead, ["rev-parse", "HEAD"]);
  }

  /**
   * **`origin` に枝を 1 本作る**（#589）。**preview へ映せる先**である。
   *
   * **作業場は動かさない**——**映す先を選ぶ口を見たい**ので、
   * **こちら側の HEAD は関係ない。**
   */
  function pushBranch(origin: string, branch: string, note: string): string {
    const side = join(mkdtempSync(join(tmpdir(), "preview-branch-")), "side");
    expect(spawnSync("git", ["clone", "--quiet", origin, side]).status).toBe(0);
    git(side, ["switch", "--quiet", "-c", branch]);
    writeFileSync(join(side, `${note}.txt`), `${note}\n`);
    git(side, ["add", "-A"]);
    git(side, [
      "-c",
      "user.email=loop@example.invalid",
      "-c",
      "user.name=loop",
      "commit",
      "--quiet",
      "-m",
      note,
    ]);
    git(side, ["push", "--quiet", "origin", branch]);
    return git(side, ["rev-parse", "HEAD"]);
  }

  it("人が見る作業場ができる", () => {
    const { dir, env } = repo();

    const added = task(dir, env, ["loop:preview:add"]);

    expect(added.status, added.stderr).toBe(0);
    expect(git(dir, ["worktree", "list", "--porcelain"])).toContain(`${dir}-preview`);
  });

  it("worker の作業場の一覧には出さない", () => {
    // **混ぜると、周回を回さないものが「止まっている worker」として数えられる**
    // ——**`bin/loop-cadence` がここを読む**（#378）。**人が呼ばれ続ける。**
    const { dir, env } = repo();
    expect(task(dir, env, ["loop:preview:add"]).status).toBe(0);

    const paths = task(dir, env, ["loop:worker:paths"]);

    expect(paths.status, paths.stderr).toBe(0);
    expect(paths.stdout, "人が見る作業場を worker として数えている").not.toContain(
      `${dir}-preview`,
    );
  });

  it("作業場の HEAD ではなく、origin/main を映す", () => {
    // **これが #457 の芯**である。**「未コミットの変更が映らない」だけでは足りない**
    // ——**別の worktree なら、どこに貼っても未コミットの変更は映らない**（変異で
    // 生き残った）。**判定が効くのは、作業場が `origin/main` より後ろにいるとき**である。
    const { dir, origin, env } = repo();
    const merged = advanceOrigin(dir, origin, "merged");
    // **実装途中を置く。** **`task` そのものは触らない**——**打つのはこの `task` である**
    writeFileSync(join(dir, "wip.txt"), "実装途中\n");

    expect(task(dir, env, ["loop:preview:add"]).status).toBe(0);

    expect(git(`${dir}-preview`, ["rev-parse", "HEAD"]), "作業場の側を映している").toBe(merged);
    expect(git(dir, ["rev-parse", "HEAD"]), "作業場が動いてしまっている").not.toBe(merged);
  });

  it("いつの main を映しているかが分かる", () => {
    // **完了条件**（#457）——**「マージされた」と「画面で使える」を、人が区別できること。**
    const { dir, env } = repo();
    expect(task(dir, env, ["loop:preview:add"]).status).toBe(0);

    const shown = task(dir, env, ["loop:preview:show"]);

    expect(shown.status, shown.stderr).toBe(0);
    expect(shown.stdout, "映している commit が出ていない").toContain(
      git(dir, ["rev-parse", "--short", "origin/main"]),
    );
  });

  it("main が進めば、そこまで追いつく", () => {
    // **周回の冒頭でしか追随しない**のが #457 の症状である——**追いつく口を持つ。**
    const { dir, origin, env } = repo();
    expect(task(dir, env, ["loop:preview:add"]).status).toBe(0);
    const merged = advanceOrigin(dir, origin, "next");

    expect(task(dir, env, ["loop:preview:up"]).status).toBe(0);

    expect(
      git(`${dir}-preview`, ["rev-parse", "HEAD"]),
      "main が進んでも、古いままになっている",
    ).toBe(merged);
  });

  it("既定の作業場の .env が、そのまま見える", () => {
    // **秘密は clone 本体の `.env` にだけ置く**（gitignore 済み）——**worktree には
    // 無い** (#462 のレビュー)。**`compose.yaml` の `env_file` は作業場ごとに解決される**
    // ので、**そのままだと接続値が 1 つも渡らず、`src/middleware.ts` が全要求で落ちる。**
    const { dir, env } = repo();
    writeFileSync(join(dir, ".env"), "SUPABASE_URL=http://kong:8000\n");

    expect(task(dir, env, ["loop:preview:add"]).status).toBe(0);

    expect(readFileSync(join(`${dir}-preview`, ".env"), "utf8"), ".env が届いていない").toContain(
      "SUPABASE_URL",
    );
  });

  it(".env を写さない（あとで書き換えても、同じものが見える）", () => {
    // **写すと、書き換えた日から食い違う**——**しかも「古い値で動いている」ことは
    // 画面からは分からない。** **秘密を 2 箇所に置かない**（§6）。
    const { dir, env } = repo();
    writeFileSync(join(dir, ".env"), "SUPABASE_URL=http://kong:8000\n");
    expect(task(dir, env, ["loop:preview:add"]).status).toBe(0);

    writeFileSync(join(dir, ".env"), "SUPABASE_URL=http://kong:8000\nAFTER=1\n");

    expect(
      readFileSync(join(`${dir}-preview`, ".env"), "utf8"),
      "写しているので、書き換えが届かない",
    ).toContain("AFTER=1");
  });

  it("あとから .env を置いても、上げ直しで繋がる", () => {
    // **`add` の時点では無いこともある**——**そこで諦めると、人は理由の分からない
    // 500 を見る。**
    const { dir, env } = repo();
    expect(task(dir, env, ["loop:preview:add"]).status).toBe(0);
    writeFileSync(join(dir, ".env"), "SUPABASE_URL=http://kong:8000\n");

    expect(task(dir, env, ["loop:preview:up"]).status).toBe(0);

    expect(readFileSync(join(`${dir}-preview`, ".env"), "utf8"), ".env が届いていない").toContain(
      "SUPABASE_URL",
    );
  });

  it("作業ツリーが汚れていたら、上げ直さない", () => {
    // **`git switch --detach` は、競合しない変更をそのまま残す** (#462 のレビュー)
    // ——**`origin/main` を映していると言いながら、実際には違うものが映る。**
    const { dir, env } = repo();
    expect(task(dir, env, ["loop:preview:add"]).status).toBe(0);
    writeFileSync(join(`${dir}-preview`, "task"), "#!/usr/bin/env bash\n# 手で直した\n", {
      mode: 0o755,
    });

    const up = task(dir, env, ["loop:preview:up"]);

    expect(up.status, "汚れたまま上げている").not.toBe(0);
    expect(`${up.stdout}${up.stderr}`, "何が起きているかが出ていない").toMatch(/変更/);
  });

  it("汚れているなら、映しているものが違うと言う", () => {
    // **止めるだけでは足りない。** **既に上がっている画面**は、**`show` を読んで
    // 判断される**——**そこで黙ると、違うものを `origin/main` として読む。**
    const { dir, env } = repo();
    expect(task(dir, env, ["loop:preview:add"]).status).toBe(0);
    writeFileSync(join(`${dir}-preview`, "task"), "#!/usr/bin/env bash\n# 手で直した\n", {
      mode: 0o755,
    });

    const shown = task(dir, env, ["loop:preview:show"]);

    expect(`${shown.stdout}${shown.stderr}`, "汚れていることを言っていない").toMatch(/変更/);
  });

  /**
   * **人が見る窓を 1 つにする**（#589）。
   *
   * **マージ前のものを見せる先が毎回別のポートになる**ので、**そのたびに SSH の
   * ポート転送を足すことになった**（利用者の苦情、2026-09-03）。
   *
   * **契約（#457。ここは `origin/main` を映す）は破らない**——**破れるのは、
   * 名乗らないまま差したとき**である。**だから `show` が名乗る。**
   */
  it("映す先を選べる（既定は origin/main のまま）", () => {
    const { dir, origin, env } = repo();
    expect(task(dir, env, ["loop:preview:add"]).status).toBe(0);
    const head = pushBranch(origin, "feat/look", "look");

    const up = task(dir, env, ["loop:preview:up", "origin/feat/look"]);

    expect(up.status, up.stderr).toBe(0);
    expect(git(`${dir}-preview`, ["rev-parse", "HEAD"]), "渡した枝を映していない").toBe(head);
  });

  it("渡さなければ、これまでどおり origin/main を映す", () => {
    // **既定を変えない**——**#457 の契約は、渡さなかったときの話である。**
    const { dir, origin, env } = repo();
    expect(task(dir, env, ["loop:preview:add"]).status).toBe(0);
    pushBranch(origin, "feat/look", "look");

    expect(task(dir, env, ["loop:preview:up"]).status).toBe(0);

    expect(git(`${dir}-preview`, ["rev-parse", "HEAD"]), "既定が origin/main でない").toBe(
      git(dir, ["rev-parse", "origin/main"]),
    );
  });

  it("消えた枝は、映せない", () => {
    // **`git fetch origin` は、消えた枝の remote-tracking を残す**（#600 のレビュー）
    // ——**マージされた枝を同じ ref で映し直すと、`switch` が成功し、
    // マージ前の内容が映る。** **`show` は「別の ref」とは言うが、
    // 「その枝はもう無い」とは言わない**——**同じ穴の別の口**である。
    //
    // **`bin/loop-merge` は `--delete-branch` を渡す**ので、**マージした枝は消える**
    // ——**この PR が作った口の、いちばん踏みやすい形**である。
    const { dir, origin, env } = repo();
    expect(task(dir, env, ["loop:preview:add"]).status).toBe(0);
    pushBranch(origin, "feat/gone", "gone");
    expect(task(dir, env, ["loop:preview:up", "origin/feat/gone"]).status).toBe(0);
    // **remote から消す**（マージのあとと同じ状態）
    expect(
      spawnSync("git", ["-C", origin, "branch", "--delete", "--force", "feat/gone"], {
        encoding: "utf8",
      }).status,
      "枝を消せていない",
    ).toBe(0);

    const again = task(dir, env, ["loop:preview:up", "origin/feat/gone"]);

    expect(again.status, "消えた枝を、そのまま映している").not.toBe(0);
  });

  it("origin/main を映しているなら、そう名乗る", () => {
    // **commit を出すだけでは、それが `origin/main` かどうかは言えない**
    // ——**読む人は #457 の契約から `main` だと読む**（**契約は散文にしかない**）。
    const { dir, env } = repo();
    expect(task(dir, env, ["loop:preview:add"]).status).toBe(0);
    expect(task(dir, env, ["loop:preview:up"]).status).toBe(0);

    const shown = task(dir, env, ["loop:preview:show"]);

    expect(shown.status, shown.stderr).toBe(0);
    expect(shown.stdout, "何を映しているか名乗っていない").toMatch(/origin\/main を映して/);
  });

  it("origin/main でないなら、そう言う", () => {
    const { dir, origin, env } = repo();
    expect(task(dir, env, ["loop:preview:add"]).status).toBe(0);
    pushBranch(origin, "feat/look", "look");
    expect(task(dir, env, ["loop:preview:up", "origin/feat/look"]).status).toBe(0);

    const shown = task(dir, env, ["loop:preview:show"]);

    expect(shown.status, shown.stderr).toBe(0);
    expect(shown.stdout, "origin/main だと読める形のままである").toMatch(
      /origin\/main では ?ありません/,
    );
  });

  it("手で差されても、そう言える（作業ツリーは汚れない）", () => {
    // **`git switch --detach` は木を汚さない**ので、**`[注意] 変更が残っています` は
    // 出ない**——**この Issue を作った当の操作**である（人が手で枝へ移した）。
    const { dir, origin, env } = repo();
    expect(task(dir, env, ["loop:preview:add"]).status).toBe(0);
    expect(task(dir, env, ["loop:preview:up"]).status).toBe(0);
    pushBranch(origin, "feat/hand", "hand");
    git(`${dir}-preview`, ["fetch", "--quiet", "origin", "feat/hand"]);
    git(`${dir}-preview`, ["switch", "--detach", "--quiet", "FETCH_HEAD"]);
    expect(git(`${dir}-preview`, ["status", "--porcelain"]), "木が汚れている").toBe("");

    const shown = task(dir, env, ["loop:preview:show"]);

    expect(shown.stdout, "手で差されたことを言っていない").toMatch(/origin\/main では ?ありません/);
  });

  it("同じ名前の作業場が別の場所にあれば、衝突として扱う", () => {
    // **`self` の除外は、まだ作られていない作業場の予約にだけ効かせる** (#462 のレビュー
    // 2 周目)。**ポートも compose project も basename から決まる**ので、**別のパスに
    // 同じ名前の作業場があれば、それは衝突である**——**外すと、追加は通るのに、
    // 上げたときに相手のコンテナを掴む**（**予約は、まさにそれを防ぐために入れた**）。
    const { dir, env } = repo();
    const elsewhere = join(mkdtempSync(join(tmpdir(), "preview-elsewhere-")), "valence-preview");
    git(dir, ["worktree", "add", "--detach", "--quiet", elsewhere, "HEAD"]);

    const added = task(dir, env, ["loop:preview:add"]);

    expect(added.status, "同じ名前の作業場があるのに通している").not.toBe(0);
    expect(`${added.stdout}${added.stderr}`, "何と重なるのかが出ていない").toContain(
      "valence-preview",
    );
  });

  it("`-preview` で終わる名前で clone しても、人が見る画面と重ならない", () => {
    // **接尾辞で決めていた** (#473)——**`foo-preview` で clone すると、その clone 本体と
    // その人が見る作業場（`foo-preview-preview`）が、どちらも同じポートになった。**
    // **`workspace_with_port` は呼んだ側を検査から外す**ので、**`loop:preview:add` は
    // この衝突を見つけない**——**両方を上げると、あとから上げたほうが落ちる。**
    const { dir, env } = repo("foo-preview");

    const own = task(dir, env, ["port"]).stdout.trim();
    const preview = task(dir, env, ["port", "foo-preview-preview"]).stdout.trim();

    expect(own, "clone 本体のポートを読めない").toMatch(/^\d+$/);
    expect(preview, "人が見る作業場のポートを読めない").toMatch(/^\d+$/);
    expect(own, "clone 本体と人が見る画面が、同じポートになっている").not.toBe(preview);
  });

  it("人が見る画面のポートは、clone の名前に依らない", () => {
    // **#467 で決めたこと**——**設定（許可一覧）には literal しか書けない**ので、
    // **clone の名前でポートが変わると、`valence` 以外へ clone した人はログインできない。**
    // **数字は書き写さない**（**割り当てが正**）——**名前を変えても同じ値かどうかだけを見る。**
    const ports = ["valence", "foo-preview", "z"].map((name) => {
      const { dir, env } = repo(name);
      return task(dir, env, ["port", `${name}-preview`]).stdout.trim();
    });

    expect(new Set(ports).size, `clone の名前で変わっている: ${ports.join(" / ")}`).toBe(1);
  });

  /** ホスト側から見える `docker` への呼び出し。**温めは中で走る**ので、ここが唯一の跡。 */
  function dockerCalls(dir: string): string[] {
    return readFileSync(join(dir, "docker.log"), "utf8").split("\n").filter(Boolean);
  }

  /** 温めが叩いた URL。**`docker ... exec -T app node -e <script> <url>` の最後**である。 */
  function warmedUrls(dir: string): string[] {
    return dockerCalls(dir)
      .filter((line) => line.includes(" exec "))
      .map((line) => line.split(" ").at(-1) ?? "");
  }

  it("上げ直したら、人が最初に開く画面を組み立てておく", () => {
    // **`next dev` は要求されたパスをその場で組み立てる** (#479 の実測: 入り口 43.4 秒 /
    // 盤面 7.4 秒)——**人が開くたびに待つ。** **入り口だけでは足りない**（**パスごと**）。
    const { dir, env } = repo();
    expect(task(dir, env, ["loop:preview:add"]).status).toBe(0);

    const up = task(dir, env, ["loop:preview:up"]);

    expect(up.status, up.stderr).toBe(0);
    const warmed = warmedUrls(dir);
    expect(
      warmed.some((url) => url.endsWith(":3000/")),
      `入り口を叩いていない: ${warmed}`,
    ).toBe(true);
    expect(
      warmed.some((url) => url.includes("/repos/")),
      `盤面を叩いていない: ${warmed}`,
    ).toBe(true);
  });

  it("温めるのは、人が見る作業場のコンテナである", () => {
    // **worker の作業場を温めても、人は開かない** (#495 の範囲外)——**打つ先を間違えると、
    // 温まるのは別の画面**で、**人の前の待ちはそのまま残る。**
    const { dir, env } = repo();
    expect(task(dir, env, ["loop:preview:add"]).status).toBe(0);

    expect(task(dir, env, ["loop:preview:up"]).status).toBe(0);

    const execs = dockerCalls(dir).filter((line) => line.includes(" exec "));
    expect(execs, "温めていない").not.toEqual([]);
    for (const line of execs) {
      expect(line, `別の作業場を温めている: ${line}`).toContain("-p valence-preview ");
    }
  });

  it("温められなくても、上げ直しは成功する", () => {
    // **温めは速さのためのもの**で、**上がったかどうかとは別**である
    // ——**ここで落とすと、画面は上がっているのに「失敗した」と読まれる。**
    const { dir, env } = repo();
    expect(task(dir, env, ["loop:preview:add"]).status).toBe(0);
    writeFileSync(join(dir, "warm.fail"), "99");

    const up = task(dir, { ...env, VALENCE_WARM_WAIT_SEC: "0" }, ["loop:preview:up"]);

    expect(up.status, up.stderr).toBe(0);
    expect(`${up.stdout}${up.stderr}`, "落ちたことを黙っている").toContain("温められませんでした");
  });

  it("応答が返るまで待つ（繋がっただけでは温めない）", () => {
    // **`./task up` はコンテナを起こしたら返る**ので、**`next dev` はまだ聞いていない。**
    // **TCP では判定しない** (#479)——**Docker の port publish は TCP を先に受ける**ので、
    // **繋がっても中身はまだ**である。**応答が返ることで見る**＝**返らなければ打ち直す。**
    const { dir, env } = repo();
    expect(task(dir, env, ["loop:preview:add"]).status).toBe(0);
    writeFileSync(join(dir, "warm.fail"), "2");

    const up = task(dir, { ...env, VALENCE_WARM_WAIT_SEC: "30" }, ["loop:preview:up"]);

    expect(up.status, up.stderr).toBe(0);
    const entry = warmedUrls(dir).filter((url) => url.endsWith(":3000/"));
    expect(entry.length, `打ち直していない: ${warmedUrls(dir)}`).toBeGreaterThan(1);
  });

  it("1 本に許す時間は、残りの上限を超えない", () => {
    // **2 つの上限を合成しない** (#496 のレビュー)。**期限を見るのは要求が返ってから**
    // なので、**期限の直前に打ち直しが始まると、そのぶんまるごと待つ**
    // ——**上限 60 秒のつもりが、1 パスで 4 分・2 パスで 8 分**になる。
    // **`up` は止まらないが、返ってこない**（**この口が消しに来た待ちを、自分で作る**）。
    const { dir, env } = repo();
    expect(task(dir, env, ["loop:preview:add"]).status).toBe(0);

    expect(task(dir, { ...env, VALENCE_WARM_WAIT_SEC: "5" }, ["loop:preview:up"]).status).toBe(0);

    const asked = dockerCalls(dir)
      .filter((line) => line.includes(" exec "))
      .map((line) => Number(line.match(/WARM_REQUEST_MS=(\d+)/)?.[1] ?? -1));
    expect(asked, "温めていない").not.toEqual([]);
    for (const ms of asked) {
      expect(ms, `残りの上限（5 秒）を超えて待とうとしている: ${ms}ms`).toBeLessThanOrEqual(5000);
    }
  });

  it("返らない相手でも、上限のうちに上げ直しが返る", () => {
    // **踏むのは、いちばん困っているとき**である——**ふつうに温まる道では出ない**
    // （**1 本目が返れば打ち直さない**）。**出るのは、組み立てが詰まる場面**——
    // **まさにこの口が長い上限を置いた理由の場面**である。
    const { dir, env } = repo();
    expect(task(dir, env, ["loop:preview:add"]).status).toBe(0);
    writeFileSync(join(dir, "warm.hang"), "");

    const started = Date.now();
    const up = task(dir, { ...env, VALENCE_WARM_WAIT_SEC: "6" }, ["loop:preview:up"]);
    const elapsed = (Date.now() - started) / 1000;

    expect(up.status, up.stderr).toBe(0);
    // **上限は全体で 1 つ**である——**パスごとに置き直すと、パスの数だけ伸びる**
    // （**出力にも `SKILL.md` にも「上限 N 秒」と書いてある**）。
    expect(elapsed, `上限 6 秒のはずが ${elapsed.toFixed(1)} 秒かかっている`).toBeLessThan(10);
  });

  it("温められなければ、`./task warm` は失敗として返す", () => {
    // **呑むのは `loop:preview:up` の側**である——**ここで 0 を返すと、
    // 「落ちても上げ直しは成功する」を確かめる術が無くなる**
    // （**呑む側を消しても、どの試験も赤くならない**）。
    const { dir, env } = repo();
    writeFileSync(join(dir, "warm.fail"), "99");

    const warmed = task(dir, { ...env, VALENCE_WARM_WAIT_SEC: "0" }, ["warm"]);

    expect(warmed.status, "温められなかったのに、成功として返している").not.toBe(0);
  });

  it("温めると up が長くなることを、打つ前に言う", () => {
    // **待ちが消えるのではなく、人の前から `up` の中へ移るだけ**である
    // ——**「速くなった」と読ませない。**
    const { dir, env } = repo();
    expect(task(dir, env, ["loop:preview:add"]).status).toBe(0);

    const up = task(dir, env, ["loop:preview:up"]);

    expect(up.stdout, "up が長くなることを言っていない").toContain("up はそのぶん長くなります");
  });

  it("`-preview` で終わる名前でも、人が見る作業場を作れる", () => {
    // **弾かれてはいけない側**——**衝突しないなら、これまでどおり作れる**
    const { dir, env } = repo("foo-preview");

    const added = task(dir, env, ["loop:preview:add"]);

    expect(added.status, `${added.stdout}${added.stderr}`).toBe(0);
    expect(git(dir, ["worktree", "list", "--porcelain"])).toContain(`${dir}-preview`);
  });

  it("clone 本体と同じポートへ落ちる worker 名も、足す前に弾く", () => {
    // **clone 本体は `git worktree list` に出ているのに、検査から外れていた**
    // （#473 のレビュー。#195 から在る 1 行）——**実在してポートを握っている作業場**である。
    //
    // **数字を書き写していない。本物に探させた**（`foo-preview` と
    // `foo-preview-worker-w104` は、どちらも同じポートへ落ちる）。
    const { dir, env } = repo("foo-preview");

    const clash = task(dir, env, ["loop:worker:add", "w104"]);

    expect(clash.status, "clone 本体とポートが重なる名前を通している").not.toBe(0);
    expect(`${clash.stdout}${clash.stderr}`, "何と重なるのかが出ていない").toMatch(
      /ポート \d+ が foo-preview と重なります/,
    );
  });

  it("人が見る画面と同じポートへ落ちる worker 名は、足す前に弾く", () => {
    // **作られていなくても予約する**（#195 のレビュー 2 周目と同じ形）——**順番を
    // 変えただけで踏める**（`add` を先に、`loop:preview:add` を後に打つ）。
    //
    // **数字を書き写していない。本物に探させた**（`valence-worker-fh` と
    // `valence-preview` は、どちらも同じポートへ落ちる）。
    const { dir, env } = repo();

    const clash = task(dir, env, ["loop:worker:add", "fh"]);

    expect(clash.status, "人が見る画面とポートが重なる名前を通している").not.toBe(0);
    expect(`${clash.stdout}${clash.stderr}`, "何と重なるのかが出ていない").toContain("preview");
  });
});
