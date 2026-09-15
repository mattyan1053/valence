/**
 * **このリポジトリの bash を lint する**（#377）。
 *
 * **`bin/` は lint の外にあった**——**見ていたのは `task` と `docker-entrypoint.sh` の
 * 2 つだけ**で、**ループの中身（lease・停止カウンタ・ゲート・出口）は 1 つも
 * 入っていなかった。** **実測**: PR #376 で `task` を触ったから SC1010 を拾えた
 * ——**同じものを `bin/` に書いていたら、CI も気づかない。**
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./lint-shell", import.meta.url));
const BIN_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function run(
  args: string[],
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(SCRIPT, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe("bin/lint-shell", () => {
  /** 対象の basename。**パスの書き方には依存しない。** */
  function listed(): string[] {
    return run(["--list"])
      .stdout.split("\n")
      .filter(Boolean)
      .map((path) => basename(path));
  }

  it("bin/ の bash を、1 つ残らず対象にする", () => {
    // **一覧を書き写さない**——**次に足したスクリプトが黙って外れる**（§5）。
    // **除くのは試験だけ**（**あれは bash ではない**）
    const scripts = readdirSync(BIN_DIR).filter(
      (name) => !name.endsWith(".test.ts") && statSync(join(BIN_DIR, name)).isFile(),
    );

    expect(listed()).toEqual(expect.arrayContaining(scripts));
  });

  it("入口の 2 つも、これまでどおり見る", () => {
    expect(listed()).toEqual(expect.arrayContaining(["task", "docker-entrypoint.sh"]));
  });

  it("試験は対象にしない", () => {
    expect(listed().filter((name) => name.endsWith(".test.ts"))).toEqual([]);
  });

  it("shellcheck が無ければ、緑にしない", () => {
    // **skip は緑に見える**（#210）——**見ていないことを「指摘なし」と答えない。**
    //
    // **呼ぶものを差し替えて見る**——**この試験はコンテナの中で走り**（shellcheck は
    // 入っていない）、**手元やホストでは入っていることがある**。**どちらでも同じ形で
    // 確かめられるようにする。**
    const result = run([], { LOOP_SHELLCHECK: "shellcheck-does-not-exist" });

    expect(result.status, "無いのに通している").toBe(2);
    expect(result.stderr, "何が無いのか読めない").toContain("shellcheck");
  });

  // **「いま指摘が 0 件であること」は CI が見る**（`.github/workflows/audit.yml`）。
  // **ここでは見ない**——**この試験はコンテナの中で走り、shellcheck が入っていない。**
  // **入れる判断は別の PR**（イメージを作り直す必要があり、走っている作業場が赤くなる）。

  it("使い方の誤りは、緑にしない", () => {
    expect(run(["--everything"]).status).toBe(2);
  });
});

/**
 * **`| grep -q` を見つける**（#742）。
 *
 * **`grep -q` は最初に当たった時点で終わる**ので、**左側がまだ書いていると SIGPIPE で
 * 死に、終了コードは 141。** **`set -o pipefail` を張っていると、パイプ全体が非ゼロ**
 * になり、**「当たった」が「落ちた」として読まれる。**
 *
 * **実測（#742）**: **4 worktree ぶんの一覧で 300 回中 3 回**——**約 1%。**
 * **`task loop:worker:paths` が master の作業場を worker として並べ**、
 * **`bin/loop-cadence` が「止まっているセッションを起こせ」と言った**（**居ない**）。
 *
 * **shellcheck は見つけない**（**SIGPIPE の規則が無い**）ので、ここで見る。
 *
 * **判定だけを取り出して測る**（`AGENTS.md` §4）——**当たる形と当たらない形を
 * 隣どうしに置く。** **本物の `bin/` には（直したあと）当たる行が無い**ので、
 * **そこからは広さを測れない。**
 */
describe("パイプの先の `grep -q`", () => {
  let roots: string[] = [];

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
    roots = [];
  });

  /** **本物の `bin/lint-shell` を、作った木の中で走らせる。** */
  function lintOf(scripts: Record<string, string>): {
    status: number;
    stdout: string;
    stderr: string;
  } {
    const root = mkdtempSync(join(tmpdir(), "lint-shell-pipes-"));
    roots.push(root);
    mkdirSync(join(root, "bin"));
    copyFileSync(SCRIPT, join(root, "bin", "lint-shell"));
    chmodSync(join(root, "bin", "lint-shell"), 0o755);
    for (const name of ["task", "docker-entrypoint.sh"]) {
      writeFileSync(join(root, name), "#!/usr/bin/env bash\necho ok\n", { mode: 0o755 });
    }
    for (const [name, body] of Object.entries(scripts)) {
      writeFileSync(join(root, "bin", name), body, { mode: 0o755 });
    }
    // **shellcheck は差し替える**——**見たいのはこちらの規則のほう**である。
    const result = spawnSync(join(root, "bin", "lint-shell"), [], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, LOOP_SHELLCHECK: "true" },
    });

    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  it("パイプの先で `grep -q` を読んでいたら、緑にしない", () => {
    const result = lintOf({
      offender: '#!/usr/bin/env bash\nprintf "%s\\n" "$x" | grep -qxF "$y"\n',
    });

    expect(result.status, "SIGPIPE で裏返る形を通している").toBe(1);
    expect(result.stderr, "どの行か読めない").toContain("offender");
  });

  it("`<<<` から読む `grep -q` は、通す", () => {
    // **パイプを通らない**ので、**SIGPIPE を受けない**（`bin/loop-request-changes` の形）。
    const result = lintOf({ fine: '#!/usr/bin/env bash\ngrep -qxF "$y" <<<"$x"\n' });

    expect(result.status, "パイプを通らない形まで落としている").toBe(0);
  });

  it("`-q` の無い `grep` は、通す", () => {
    // **最後まで読む**ので、**左側が SIGPIPE を受けない。**
    const result = lintOf({ fine: '#!/usr/bin/env bash\nprintf "%s\\n" "$x" | grep -xF "$y"\n' });

    expect(result.status, "読み切る形まで落としている").toBe(0);
  });

  it("`awk` が `exit` で抜ける形も、緑にしない", () => {
    // **守りたいのは「右が読み切らずに終わる」**で、**`grep -q` はその一例**
    // （#742 のコメント。**数える語を `grep -q` にすると、範囲はその語で決まる**）。
    const result = lintOf({
      offender: '#!/usr/bin/env bash\nprintf "%s\\n" "$x" | awk \'/^a/{print $2; exit}\'\n',
    });

    expect(result.status, "1 行目で抜ける awk を通している").toBe(1);
  });

  it("`head` で切る形も、緑にしない", () => {
    const result = lintOf({ offender: '#!/usr/bin/env bash\nprintf "%s\\n" "$x" | head -n 1\n' });

    expect(result.status, "先頭だけ読む head を通している").toBe(1);
  });

  it("読み切る `awk` は、通す", () => {
    // **`exit` が無ければ最後まで読む**（`task` の `loop:stop:paths` がその形）。
    const result = lintOf({
      fine: '#!/usr/bin/env bash\nprintf "%s\\n" "$x" | awk \'{print $2}\'\n',
    });

    expect(result.status, "読み切る形まで落としている").toBe(0);
  });

  it("書式文字列の中の `|` は、通す", () => {
    // **語で数えると両方向に外れる**（#742 のコメント）——**狭いと落とし、
    // 広いと拾いすぎる。** **`printf 'pr=%s|head=%s'` はパイプではない。**
    const result = lintOf({
      fine: '#!/usr/bin/env bash\nprintf \'pr=%s|head=%s\' "$a" "$b"\n',
    });

    expect(result.status, "書式文字列をパイプと読んでいる").toBe(0);
  });

  it("説明の中の `| grep -q` は、通す", () => {
    // **このリポジトリは理由を厚く書く**（`AGENTS.md` §4）——**注釈に出てくる語で
    // 落とすと、直した説明そのものが引っかかる。**
    const result = lintOf({
      fine: "#!/usr/bin/env bash\n# printf … | grep -q は SIGPIPE で死ぬ\ntrue\n",
    });

    expect(result.status, "注釈で落としている").toBe(0);
  });
});
