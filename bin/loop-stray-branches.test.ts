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
type Pr = {
  head: string;
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  /** **fork から出た PR。** origin の同名ブランチとは**別物**である。 */
  crossRepo?: boolean;
};

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
    /**
     * **いま作業中のブランチ**（走っている worker の作業場で checkout されているもの）。
     *
     * **「どこかで走っているか」ではない。** どこか 1 つでも走っていれば全部隠すと、
     * **worker が途切れず動く環境では紛失作業が永久に見つからない**。
     */
    busyBranches?: string[];
    /** 走っているかどうかを読めない（`bin/loop-lease busy` が exit 2）。 */
    busyUnreadable?: boolean;
    gitFails?: boolean;
    ghFails?: boolean;
  }): { status: number; stdout: string; stderr: string } {
    const stub = join(sandbox, "stub");
    mkdirSync(stub, { recursive: true });
    mkdirSync(join(sandbox, "bin"), { recursive: true });

    const busyBranches = options.busyBranches ?? [];
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
        // **走っている作業場で、いま checkout されているブランチ**を答える
        'if [[ $* == *"symbolic-ref"* ]]; then',
        // **空のものは答えない**（＝そのブランチを読めない状態を作る）
        ...busyBranches.flatMap((branch, index) =>
          branch === ""
            ? []
            : [
                `  [[ $* == *"/workspace-${index}"* ]] && { printf '%s\\n' ${JSON.stringify(branch)}; exit 0; }`,
              ],
        ),
        "  exit 1",
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
        // **ブランチごとに引く。** **一括で取ると、上限を超えた古い PR が「無い」に化ける**
        // （この repo は既に PR が 171 件）。**fork の PR は別物**なので、
        // **同じリポジトリのものだけ**を返す（`isCrossRepository` で絞るのは呼ぶ側）
        ...options.prs.map(
          (pr) =>
            `if [[ $* == *"--head ${pr.head}"* ]]; then printf '%s\\u001f%s\\u001f%s\\n' ${pr.number} ${pr.state} ${pr.crossRepo === true ? "true" : "false"}; exit 0; fi`,
        ),
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    // **走っている作業場は lease が持つ。** ここでは答えだけを差し替える
    writeFileSync(
      join(sandbox, "bin", "loop-lease"),
      [
        "#!/usr/bin/env bash",
        ...(options.busyUnreadable === true ? ["exit 2"] : []),
        ...busyBranches.map((_branch, index) => `printf '%s\\n' "/workspace-${index}"`),
        `exit ${busyBranches.length > 0 ? 0 : 1}`,
        "",
      ].join("\n"),
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

  it("いま作業中のブランチは、挙げない", () => {
    // **push から PR 作成までの間に、必ず窓が開く**（master が実測。#148 のコメント）。
    // **時間で切らない**——**遅い周回と落ちた周回は、経過時間では分けられない**（#129）
    const result = run({
      branches: [{ name: "feat/just-pushed" }],
      prs: [],
      busyBranches: ["feat/just-pushed"],
    });

    expect(result.status, "健全な周回の途中で鳴っている").toBe(0);
    expect(result.stdout).toBe("");
  });

  it("走っている周回と無関係なブランチは、隠さない", () => {
    // **ここが本命である。** **どこか 1 つでも走っていれば全部隠す**と、
    // **worker が途切れず動く環境では紛失作業が永久に見つからない**——
    // **動いているほど見つからない**という、**向きが逆**の壊れ方になる（#148 のレビュー）
    const result = run({
      branches: [{ name: "feat/just-pushed" }, { name: "feat/lost-long-ago" }],
      prs: [],
      busyBranches: ["feat/just-pushed"],
    });

    expect(result.status).toBe(1);
    expect(result.stdout, "無関係なブランチまで隠している").toContain("feat/lost-long-ago");
    expect(result.stdout, "作業中のブランチを挙げている").not.toContain("feat/just-pushed");
  });

  it("走っているか読めなければ、0 件とも「宙に浮いている」とも言わない", () => {
    // **契約は `exit 2 = 読めない`。** **どちらかへ倒すと、片方の誤りをそのまま作る**
    const result = run({
      branches: [{ name: "feat/x" }],
      prs: [],
      busyUnreadable: true,
    });

    expect(result.status).toBe(2);
  });

  it("周回が走っていても、消し残りは挙げる", () => {
    // **窓は「PR がまだ無い」ほうにしか開かない。** 消し残りは**終わったもの**なので、
    // 走っている周回とは関係が無い
    const result = run({
      branches: [{ name: "feat/done" }],
      prs: [{ head: "feat/done", number: 76, state: "MERGED" }],
      busyBranches: ["feat/done"],
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("merged-leftover");
  });

  it("fork の PR は、origin の同名ブランチと同一視しない", () => {
    // **`headRefName` だけをキーにすると、fork の PR が origin の無関係なブランチに
    // 対応付けられる**——**終わっていれば「消してよい」と表示され、
    // 手順どおり消すと PR に残っていない作業が消える**（#148 が塞ごうとした穴を、
    // 塞ぐ側が広げる形）。**同じリポジトリの PR だけを見る**
    const result = run({
      branches: [{ name: "feat/same-name" }],
      prs: [{ head: "feat/same-name", number: 200, state: "MERGED", crossRepo: true }],
    });

    expect(result.status).toBe(1);
    expect(result.stdout, "fork の PR を自分のものとして数えている").toContain("no-pr");
    expect(result.stdout).not.toContain("merged-leftover");
  });

  it("ブランチごとに引く（一括の上限に依らない）", () => {
    // **一括で取ると、上限を超えた古い PR が「無い」に化ける**——
    // **この repo は既に PR が 171 件**で、**古いマージ済みの消し残りが
    // 人の判断待ちとしてループを止める**
    const result = run({
      branches: [{ name: "feat/ancient" }],
      prs: [{ head: "feat/ancient", number: 3, state: "MERGED" }],
    });

    expect(result.status).toBe(1);
    expect(result.stdout, "ブランチごとに引けていない").toContain("merged-leftover");
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

  it("走っている作業場のブランチを読めなければ、判定しない", () => {
    // **走っているのに、どのブランチを触っているか分からない**——
    // **抑えるべきかどうかが決められない**ので、**どちらへも倒さない**
    const result = run({
      branches: [{ name: "feat/x" }],
      prs: [],
      // **走ってはいるが、どのブランチを触っているか読めない**
      busyBranches: [""],
    });

    expect(result.status).toBe(2);
  });

  it("読めなければ、0 件と同じ顔をしない", () => {
    // **「無かった」と「読めなかった」を同じ値に丸めない**（#136 と同じ家族）
    expect(run({ branches: [], prs: [], gitFails: true }).status).toBe(2);
    expect(run({ branches: [{ name: "feat/x" }], prs: [], ghFails: true }).status).toBe(2);
  });
});
