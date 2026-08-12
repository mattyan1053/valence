import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-stray-branches", import.meta.url));

/** remote のブランチ。`git ls-remote --heads` の形。 */
type Branch = { name: string; sha?: string };
/** その head を持つ PR。 */
type Pr = { head: string; number: number; state: "OPEN" | "MERGED" | "CLOSED" };

/**
 * push されたのに PR が無いブランチを、誰かが見る（#148）。
 *
 * **master は open PR を見て、worker は label を見る。どちらも remote のブランチを
 * 見ない**ので、**PR にならなかったものは、どちらの視界にも入らない**——
 * **実物が 1 日半、誰にも見られずに置かれていた**（365 行の実装と試験）。
 *
 * **倒れる向きが悪い。** 落ちた周回の残りなら、**Issue は `backlog` へ戻っている**ので、
 * **次に取った worker はブランチの存在を知らないまま最初から作り直す**。
 *
 * **2 つを混ぜない。** **PR が無い**（作業が宙に浮いている。**人へ渡す**）と
 * **終わった PR の消し残り**（**掃除してよい**）は、**拾い手も対処も違う**。
 */
describe("bin/loop-stray-branches", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "stray-branches-"));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  /**
   * `git` と `gh`、そして「着手中の周回があるか」を差し替える。
   *
   * **押し通す判定は持たせない。** 生きている着手の記録があるかは
   * `bin/loop-lease` が持つ（**2 箇所に持つと片方だけ直して食い違う**）。
   */
  function run(options: {
    branches: Branch[];
    prs: Pr[];
    /** worker の周回が走っているか（**push から PR 作成までの窓**）。 */
    busy?: boolean;
    gitFails?: boolean;
    ghFails?: boolean;
  }): { status: number; stdout: string; stderr: string } {
    const stub = join(sandbox, "stub");
    mkdirSync(stub, { recursive: true });
    mkdirSync(join(sandbox, "bin"), { recursive: true });

    writeFileSync(
      join(stub, "git"),
      [
        "#!/usr/bin/env bash",
        ...(options.gitFails === true ? ['echo "git が落ちた" >&2', "exit 1"] : []),
        'if [[ $* == *"ls-remote"* ]]; then',
        ...options.branches.map(
          (branch) =>
            `  printf '%s\\t%s\\n' ${JSON.stringify(branch.sha ?? "a".repeat(40))} ${JSON.stringify(`refs/heads/${branch.name}`)}`,
        ),
        "  exit 0",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(
      join(stub, "gh"),
      [
        "#!/usr/bin/env bash",
        ...(options.ghFails === true ? ['echo "gh が落ちた" >&2', "exit 1"] : []),
        ...options.prs.map(
          // **区切りは US。** タブは `IFS` の空白として畳まれる（スクリプトと同じ形）
          (pr) =>
            `printf '%s\\u001f%s\\u001f%s\\n' ${JSON.stringify(pr.head)} ${pr.number} ${pr.state}`,
        ),
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    // **周回が走っているかは lease が持つ。** ここでは答えだけを差し替える
    writeFileSync(
      join(sandbox, "bin", "loop-lease"),
      ["#!/usr/bin/env bash", `exit ${options.busy === true ? 0 : 1}`, ""].join("\n"),
      { mode: 0o755 },
    );

    // **隣を差し替えるために、写してから走らせる。** スクリプトは
    // `${BASH_SOURCE%/*}/loop-lease` を引く（PATH ではない）ので、**同じ場所に置く**
    const copied = join(sandbox, "bin", "loop-stray-branches");
    copyFileSync(SCRIPT, copied);
    chmodSync(copied, 0o755);

    const result = spawnSync(copied, [], {
      cwd: sandbox,
      encoding: "utf8",
      env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
    });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  it("PR が無いブランチを挙げる", () => {
    const result = run({ branches: [{ name: "feat/lost" }], prs: [] });

    expect(result.status, "見つけたのに 0 を返している").toBe(1);
    expect(result.stdout).toContain("feat/lost");
    expect(result.stdout, "種類が出ていない").toContain("no-pr");
  });

  it("終わった PR の消し残りは、別の種類で挙げる", () => {
    // **拾い手も対処も違う。** **こちらは消してよい**——作業は PR に残っている
    const result = run({
      branches: [{ name: "feat/done" }],
      prs: [{ head: "feat/done", number: 76, state: "MERGED" }],
    });

    expect(result.status).toBe(1);
    expect(result.stdout, "種類が出ていない").toContain("merged-leftover");
    expect(result.stdout, "どの PR かが出ていない").toContain("76");
  });

  it("open な PR の head は、宙に浮いていない", () => {
    // **作業中のブランチを報告すると、毎周回出る警告になって読まれなくなる**
    const result = run({
      branches: [{ name: "feat/working" }],
      prs: [{ head: "feat/working", number: 99, state: "OPEN" }],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("main は見ない", () => {
    expect(run({ branches: [{ name: "main" }], prs: [] }).status).toBe(0);
  });

  it("周回が走っている間は、PR が無いブランチを挙げない", () => {
    // **push から PR 作成までの間に、必ず窓が開く**（master が実測。#148 のコメント）。
    // **時間で切らない**——**遅い周回と落ちた周回は、経過時間では分けられない**（#129）。
    // **着手の記録が生きているか**を見る（動いている worker だけが更新する）
    const result = run({ branches: [{ name: "feat/just-pushed" }], prs: [], busy: true });

    expect(result.status, "健全な周回の途中で鳴っている").toBe(0);
    expect(result.stdout).toBe("");
  });

  it("周回が走っていても、消し残りは挙げる", () => {
    // **窓は「PR がまだ無い」ほうにしか開かない。** 消し残りは**終わったもの**なので、
    // 走っている周回とは関係が無い
    const result = run({
      branches: [{ name: "feat/done" }],
      prs: [{ head: "feat/done", number: 76, state: "MERGED" }],
      busy: true,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("merged-leftover");
  });

  it("平常時は、何も出さない", () => {
    // **毎周回出る警告にしない**（`bin/loop-merge` の消し残り警告が実際にそうなった）
    const result = run({
      branches: [{ name: "main" }, { name: "feat/working" }],
      prs: [{ head: "feat/working", number: 99, state: "OPEN" }],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("読めなければ、0 件と同じ顔をしない", () => {
    // **「無かった」と「読めなかった」を同じ値に丸めない**（#136 と同じ家族）
    expect(run({ branches: [], prs: [], gitFails: true }).status).toBe(2);
    expect(run({ branches: [{ name: "feat/x" }], prs: [], ghFails: true }).status).toBe(2);
  });
});
