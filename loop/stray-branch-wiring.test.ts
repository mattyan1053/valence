import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROCEDURE = ".claude/commands/loop-master.md";

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/**
 * 宙に浮いたブランチが、人の目に触れる場所へ出るか（#148）。
 *
 * **master は open PR を見て、worker は label を見る。** どちらも remote のブランチを
 * 見ないので、**PR にならなかったものは、どちらの視界にも入らない**。
 *
 * **拾い手は 2 つ**（#163 / #167 と同じ判断）。**master の周回の出口**は毎周回通るが、
 * **master 自身が見つけたときは誰にも送れない**（#167 で踏んだ）ので、**そこで自分で扱う**。
 * **`./task loop:status`** は人が読む場所である。
 */
describe("宙に浮いたブランチ", () => {
  /** master の「周回の出口」の節。 */
  function exitSection(): string {
    const after = read(PROCEDURE).split("### 周回の出口")[1] ?? "";
    return after.split(/\n#{2,3} /)[0] ?? "";
  }

  /**
   * その節で**実際に打つもの**（bash ブロック）。
   *
   * **散文で見ない。** 節全体を見ると**説明に名前があるだけで満たされ**、
   * **ブロックから消しても緑のまま**になる——**#168 / #169 で 2 度踏んだ形**である。
   */
  function exitCommands(): string {
    return exitSection()
      .split("```bash")
      .slice(1)
      .map((chunk) => chunk.split("```")[0] ?? "")
      .join("\n");
  }

  it("master の周回の出口が、毎周回見る", () => {
    // **場面を並べない**（「マージしたとき」「push したとき」…）——**経路が増えると漏れる**
    // （#92 と同じ形）。**状態から機械的に決まる**ので、`bin/loop-claim audit` と同じ場所で見る
    const commands = exitCommands();

    expect(commands, "出口で打っていない").toContain("bin/loop-stray-branches");
    expect(commands, "audit と同じ場所に置いていない").toContain("bin/loop-claim audit");
  });

  it("種類ごとに、行き先が分かれている", () => {
    // **拾い手も対処も違う。** **消し残りは掃除してよい**が、
    // **PR が無いものは救うか捨てるかを判定できない**ので**人へ渡す**
    const section = exitSection();

    expect(section, "消し残りの扱いが無い").toContain("merged-leftover");
    expect(section, "宙に浮いたものの扱いが無い").toContain("no-pr");
    // **PR の先に積まれたものは、消してよい側ではない**（#177）——
    // **その commit はどの PR にも入っていない**
    expect(section, "PR の先に積まれたものの扱いが無い").toContain("beyond-pr");
    expect(section, "人へ渡す経路が無い").toContain('bin/loop-stall "stray-branch:<ブランチ>"');
    // **master は push しない**（絶対ルール）。**「掃除してよい」と分類することと、
    // 「master が掃除する」ことは別**である——**master の手順書に、master が
    // やってはいけないことを書かない**（master の指摘）
    expect(section, "master に push させている").not.toContain("git push origin --delete");
    expect(exitCommands(), "master に push させている").not.toContain("git push");
  });

  it("その識別子が、一覧にある", () => {
    const listed = execFileSync(join(REPO_ROOT, "bin/loop-stall"), ["--list"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    expect(listed).toContain("stray-branch:<ブランチ>");
  });

  it("./task loop:status が、見せる", () => {
    // **人が読む場所にも出す。** **master が止まっていると、出口は回らない**
    const workspace = mkdtempSync(join(tmpdir(), "stray-status-"));
    try {
      const stub = join(workspace, "stub");
      mkdirSync(stub, { recursive: true });
      mkdirSync(join(workspace, ".git"), { recursive: true });
      writeFileSync(
        join(stub, "git"),
        [
          "#!/usr/bin/env bash",
          // **lease が使う問い合わせにも答える**（実物の `bin/loop-lease busy` が走る）。
          // **実リポジトリを見せない**——**そこの lease の有無で結果が変わってしまう**
          `if [[ $* == *"--git-common-dir"* ]]; then printf '%s\\n' ${JSON.stringify(join(workspace, ".git"))}; exit 0; fi`,
          `if [[ $* == *"--show-toplevel"* ]]; then printf '%s\\n' ${JSON.stringify(workspace)}; exit 0; fi`,
          'if [[ $* == *"ls-remote"* ]]; then',
          "  printf '%s\\t%s\\n' aaaaaaaa refs/heads/feat/lost",
          "  exit 0",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      // PR は 1 件も無い（＝宙に浮いている）
      writeFileSync(join(stub, "gh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

      const shown = execFileSync(
        "bash",
        [
          "-c",
          `source ${JSON.stringify(join(REPO_ROOT, "task"))} >/dev/null 2>&1; ` +
            `PATH=${JSON.stringify(stub)}:$PATH show_stray_branches`,
        ],
        { encoding: "utf8" },
      );

      expect(shown, "どのブランチかが出ていない").toContain("feat/lost");
      expect(shown, "何が起きているのかが出ていない").toMatch(/PR/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("出たブランチ名を、そのまま記録できる", () => {
    // **「見つかったのに記録されない」は、呼ぶ側から見ないと形が分からない**
    // （master の指摘）。**検出は通るのに `bin/loop-stall` が exit 2**——
    // **人へ渡す経路がそこで切れる**（しかも **3 周の経路にも乗らない**）。
    const workspace = mkdtempSync(join(tmpdir(), "stray-record-"));
    try {
      expect(spawnSync("git", ["init", "--quiet", workspace]).status).toBe(0);
      const stub = join(workspace, "stub");
      mkdirSync(stub, { recursive: true });
      writeFileSync(
        join(stub, "git"),
        [
          "#!/usr/bin/env bash",
          `if [[ $* == *"--git-common-dir"* ]]; then printf '%s\n' ${JSON.stringify(join(workspace, ".git"))}; exit 0; fi`,
          `if [[ $* == *"--show-toplevel"* ]]; then printf '%s\n' ${JSON.stringify(workspace)}; exit 0; fi`,
          'if [[ $* == *"ls-remote"* ]]; then',
          // **git が受け付ける名前**（`+` は ref に使える）
          "  printf '%s\t%s\n' aaaaaaaa refs/heads/feat/a+b",
          "  exit 0",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      writeFileSync(join(stub, "gh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

      const found = spawnSync(join(REPO_ROOT, "bin/loop-stray-branches"), [], {
        cwd: workspace,
        encoding: "utf8",
        env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
      });
      expect(found.status, "宙に浮いたブランチを見つけていない").toBe(1);
      const branch = (found.stdout.split("\n")[0] ?? "").split("\t")[1] ?? "";
      expect(branch, "ブランチ名が出ていない").toBe("feat/a+b");

      // **出た名前を、そのまま人へ渡す経路へ通す**
      const recorded = spawnSync(join(REPO_ROOT, "bin/loop-stall"), [`stray-branch:${branch}`], {
        cwd: workspace,
        encoding: "utf8",
      });

      expect(recorded.status, "見つけたのに記録できない").toBe(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("./task loop:status から呼ばれている", () => {
    // **関数を直接呼んで確かめない**——**呼び出しを外しても緑のまま**になる
    const status = read("task").split("cmd_loop_status()")[1]?.split("\n}")[0] ?? "";

    expect(status).toContain("show_stray_branches");
  });

  it("判定は 1 箇所に置く", () => {
    // **同じ判定を 2 箇所に持つと、片方だけ直して食い違う**（#159 で踏んだ）
    for (const path of ["task", PROCEDURE]) {
      expect(read(path), `${path} が呼んでいない`).toContain("loop-stray-branches");
    }
    expect(read("task"), "task が自前で判定している").not.toContain("ls-remote");
  });

  it("平常時は、何も足さない", () => {
    // **毎周回出る警告にしない。** **読まれなくなる**のがいちばん悪い
    const workspace = mkdtempSync(join(tmpdir(), "stray-status-"));
    try {
      const stub = join(workspace, "stub");
      mkdirSync(stub, { recursive: true });
      mkdirSync(join(workspace, ".git"), { recursive: true });
      writeFileSync(
        join(stub, "git"),
        [
          "#!/usr/bin/env bash",
          // **lease が使う問い合わせにも答える**（実物の `bin/loop-lease busy` が走る）。
          // **実リポジトリを見せない**——**そこの lease の有無で結果が変わってしまう**
          `if [[ $* == *"--git-common-dir"* ]]; then printf '%s\\n' ${JSON.stringify(join(workspace, ".git"))}; exit 0; fi`,
          `if [[ $* == *"--show-toplevel"* ]]; then printf '%s\\n' ${JSON.stringify(workspace)}; exit 0; fi`,
          'if [[ $* == *"ls-remote"* ]]; then',
          "  printf '%s\\t%s\\n' aaaaaaaa refs/heads/main",
          "  exit 0",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      writeFileSync(join(stub, "gh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

      const shown = execFileSync(
        "bash",
        [
          "-c",
          `source ${JSON.stringify(join(REPO_ROOT, "task"))} >/dev/null 2>&1; ` +
            `PATH=${JSON.stringify(stub)}:$PATH show_stray_branches`,
        ],
        { encoding: "utf8" },
      );

      expect(shown).toBe("");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("読めなければ、黙って 0 件にしない", () => {
    const workspace = mkdtempSync(join(tmpdir(), "stray-status-"));
    try {
      const stub = join(workspace, "stub");
      mkdirSync(stub, { recursive: true });
      mkdirSync(join(workspace, ".git"), { recursive: true });
      writeFileSync(join(stub, "git"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
      writeFileSync(join(stub, "gh"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });

      const shown = execFileSync(
        "bash",
        [
          "-c",
          `source ${JSON.stringify(join(REPO_ROOT, "task"))} >/dev/null 2>&1; ` +
            `PATH=${JSON.stringify(stub)}:$PATH show_stray_branches`,
        ],
        { encoding: "utf8" },
      );

      expect(shown, "読めないのに何も言わない").not.toBe("");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
