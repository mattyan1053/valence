import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-stall", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

type Run = { status: number; stdout: string; stderr: string };

/** 実カウンタを壊さないよう、使い捨ての git リポジトリを cwd にして呼ぶ。 */
function run(args: string[], cwd = REPO_ROOT): Run {
  const result = spawnSync(SCRIPT, args, {
    cwd,
    encoding: "utf8",
    // 上限に達すると全ループを止めてしまうため、テストでは到達させない。
    env: { ...process.env, LOOP_MAX_STALL_REPEATS: "99" },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** `--list` が出す識別子の書式（説明は落とす）。 */
function listedSpecs(): string[] {
  const listed = run(["--list"]);
  expect(listed.status).toBe(0);
  return listed.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.trim().split(/\s+/)[0] ?? "");
}

describe("bin/loop-stall の停止識別子", () => {
  let sandbox: string;

  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), "loop-stall-"));
    const init = spawnSync("git", ["init", "--quiet", sandbox], { encoding: "utf8" });
    expect(init.status).toBe(0);
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("--list は識別子の書式と説明を一覧で出す", () => {
    const listed = run(["--list"]);

    expect(listed.status).toBe(0);
    expect(listed.stdout).toMatch(/^dirty\s+\S/m);
    expect(listedSpecs()).toContain("too-many-own-prs:<件数>");
  });

  it("同じ種別の識別子が一覧に 2 つ以上ない", () => {
    const kinds = listedSpecs().map((spec) => spec.split(":")[0]);

    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("一覧にある書式に合う識別子は受け付ける", () => {
    const accepted = run(["wrong-branch:12"], sandbox);

    expect(accepted.status).toBe(0);
    expect(accepted.stdout).toContain("count=1");
  });

  it("表記のゆれた識別子は弾き、使える識別子を示す", () => {
    // 実際に食い違っていた綴り。黙って数え直されると 3 周続いても止まらない。
    const rejected = run(["too-many-prs:2"], sandbox);

    expect(rejected.status).toBe(2);
    expect(rejected.stderr).toContain("too-many-own-prs:<件数>");
  });

  it("種別が正しくても引数の形が違えば弾く", () => {
    expect(run(["wrong-branch"], sandbox).status).toBe(2);
    expect(run(["wrong-branch:main"], sandbox).status).toBe(2);
    expect(run(["merge-failed:12"], sandbox).status).toBe(2);
  });

  it("--reset は識別子の検査を通さずカウンタを消す", () => {
    const reset = run(["--reset"], sandbox);

    expect(reset.status).toBe(0);
    expect(run(["wrong-branch:12"], sandbox).stdout).toContain("count=1");
  });
});

describe("上限に達したときに止める対象", () => {
  /**
   * スクリプトのコピーと偽の `task` を使い、上限まで走らせる。
   * **本物の bin/loop-stall をそのまま上限まで走らせない。** それをやると実際に
   * 実リポジトリの両 worktree が停止する（この Issue の事故そのもの）。
   *
   * 偽の `task` は「呼ばれた印」を残すだけ。**呼ばれてはいけない側にも置く**ので、
   * 実行されたかどうかがそのまま判定になる。
   */
  function runToLimit(options: { cwd: "same-repo" | "other-repo" }): {
    status: number;
    stderr: string;
    ranScriptRepoTask: boolean;
    ranCwdRepoTask: boolean;
  } {
    const scriptRepo = mkdtempSync(join(tmpdir(), "loop-stall-script-"));
    const otherRepo = mkdtempSync(join(tmpdir(), "loop-stall-cwd-"));
    for (const repo of [scriptRepo, otherRepo]) {
      spawnSync("git", ["init", "--quiet", repo]);
      // 呼ばれたことだけを残す task。本物のように loop/STOP は配らない
      writeFileSync(join(repo, "task"), `#!/usr/bin/env bash\ntouch '${repo}/ran'\n`, {
        mode: 0o755,
      });
    }
    mkdirSync(join(scriptRepo, "bin"));
    const script = join(scriptRepo, "bin", "loop-stall");
    copyFileSync(SCRIPT, script);
    chmodSync(script, 0o755);

    const cwd = options.cwd === "same-repo" ? scriptRepo : otherRepo;
    let result = spawnSync(script, ["dirty"], { cwd, encoding: "utf8" });
    for (let i = 0; i < 2; i++) {
      result = spawnSync(script, ["dirty"], { cwd, encoding: "utf8" });
    }
    const ran = {
      status: result.status ?? -1,
      stderr: result.stderr,
      ranScriptRepoTask: existsSync(join(scriptRepo, "ran")),
      ranCwdRepoTask: existsSync(join(otherRepo, "ran")),
    };
    rmSync(scriptRepo, { recursive: true, force: true });
    rmSync(otherRepo, { recursive: true, force: true });
    return ran;
  }

  it("cwd が別のリポジトリなら、どちらの task も実行しない", () => {
    // -x は「Valence のタスクランナーである」ことを保証しない。実行してしまうと
    // **そのリポジトリが用意した任意のコードが動く**
    const result = runToLimit({ cwd: "other-repo" });

    expect(result.ranCwdRepoTask).toBe(false);
    expect(result.ranScriptRepoTask).toBe(false);
  });

  it("cwd が別のリポジトリなら、止めなかった理由を出す", () => {
    // 黙って何もしないのは、黙って止めるのと同じくらい分かりにくい
    const result = runToLimit({ cwd: "other-repo" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("止められません");
  });

  it("シンボリックリンク経由で cd しても同じリポジトリと判定する", () => {
    // bash の cd / pwd は既定でリンクを保った論理パスを返す。到達経路が違うだけで
    // 別リポジトリ扱いになると、**止まっていないのに exit 1（停止済み）を返す**
    const scriptRepo = mkdtempSync(join(tmpdir(), "loop-stall-script-"));
    spawnSync("git", ["init", "--quiet", scriptRepo]);
    writeFileSync(join(scriptRepo, "task"), `#!/usr/bin/env bash\ntouch '${scriptRepo}/ran'\n`, {
      mode: 0o755,
    });
    mkdirSync(join(scriptRepo, "bin"));
    const script = join(scriptRepo, "bin", "loop-stall");
    copyFileSync(SCRIPT, script);
    chmodSync(script, 0o755);
    const link = `${scriptRepo}-link`;
    symlinkSync(scriptRepo, link);

    // Node の cwd 指定では物理パスに解決されてしまうので、シェルの cd を通す
    let result: ReturnType<typeof spawnSync>;
    for (let i = 0; i < 3; i++) {
      result = spawnSync("/usr/bin/bash", ["-c", `cd '${link}' && '${script}' dirty`], {
        encoding: "utf8",
      });
    }
    const ran = existsSync(join(scriptRepo, "ran"));
    // biome-ignore lint/style/noNonNullAssertion: ループで必ず代入される
    const stderr = result!.stderr as unknown as string;
    rmSync(link, { force: true });
    rmSync(scriptRepo, { recursive: true, force: true });

    expect(stderr).not.toContain("止められません");
    expect(ran).toBe(true);
  });

  it("cwd がスクリプトと同じリポジトリなら止める", () => {
    const result = runToLimit({ cwd: "same-repo" });

    expect(result.status).toBe(1);
    expect(result.ranScriptRepoTask).toBe(true);
  });

  it("実リポジトリの loop/STOP は作られない", () => {
    runToLimit({ cwd: "other-repo" });

    expect(existsSync(join(REPO_ROOT, "loop", "STOP"))).toBe(false);
  });
});

describe("ドキュメントに書かれた停止識別子", () => {
  /**
   * 追跡下の Markdown から `bin/loop-stall <引数>` の呼び出しを拾う。
   * 引数が ASCII で始まるものだけを見る（「bin/loop-stall を通す」のような地の文を除く）。
   */
  function documentedArgs(): { file: string; arg: string }[] {
    const files = execFileSync("git", ["ls-files", "*.md"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter((path) => path !== "");

    const pattern = /bin\/loop-stall[ \t]+("[^"\n]*"|[-<A-Za-z0-9][^\s`"]*)/g;
    return files.flatMap((file) => {
      const body = readFileSync(join(REPO_ROOT, file), "utf8");
      return [...body.matchAll(pattern)].map((match) => ({
        file,
        arg: (match[1] ?? "").replace(/^"|"$/g, ""),
      }));
    });
  }

  it("ドキュメントに出てくる識別子はすべて一覧に載っている", () => {
    const known = new Set([...listedSpecs(), "--reset", "--list"]);

    const unknown = documentedArgs().filter(({ arg }) => !known.has(arg));

    expect(unknown).toEqual([]);
  });

  it("識別子を使う判定箇所が実際に存在する", () => {
    const args = documentedArgs().map(({ arg }) => arg);

    expect(args.filter((arg) => !arg.startsWith("--")).length).toBeGreaterThan(0);
  });
});
