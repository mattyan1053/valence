/**
 * **`no-work` で止めたあと、仕事が入っても誰も気づかない**（#634）。
 *
 * **実測: PR #625 が来てから人が再開するまで 10 時間 45 分。** **その間 master の
 * cron は 30 分ごとに鳴り、約 21 回「何もせず停止します」を返している**——
 * **止めた理由が消えたことは、どこにも出ていなかった。**
 *
 * **`loop/STOP` は弱めない。** **ここで見るのは「1 行出すかどうか」だけ**である
 * ——**STOP を消さないこと・仕事を取らないことは、入口の側の約束**
 * （`loop/stop-cleared-wiring.test.ts`）。
 *
 * **走らせて見る**（`loop/no-work-human-waiting.test.ts` と同じ形）。**偽の `gh` を
 * 置き、数える側は本物**にする——**見たいのは「本物の口へ繋がっているか」**である。
 * **実物の `loop/STOP` は置かない**（`AGENTS.md` §5。**走っているものと競る**）。
 */

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 列の区切り。**本物と同じ**（`bin/loop-open-work` が読む形）。 */
const FIELD = "";

/** ループが認証しているアカウント。**中から出た PR** の既定である。 */
const LOOP_ACCOUNT = "loop-account";

/** 数える側が要るスクリプト。**本物を置く**——**偽物にすると、繋がりを見ていない。** */
const SCRIPTS = [
  "loop-stop-cleared",
  "loop-open-work",
  "loop-in-progress-work",
  "loop-outside-author",
  "loop-issue-descendants",
] as const;

type Pr = { number: number; branch?: string; author?: string; labels: string[] };

type Board = {
  /** `loop/STOP` の中身。**`undefined` なら置かない。** */
  stop?: string;
  prs?: readonly Pr[];
  ready?: readonly number[];
  inProgress?: readonly number[];
  /** `gh` が落ちる一覧。**「読めなかった」を「0 件」に化けさせない**ため。 */
  breaks?: "pr" | "ready" | "in-progress";
};

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 1 行 1 PR の一覧（**本物の `--jq` が出す形**）。 */
function renderPrs(prs: readonly Pr[]): string {
  return prs
    .map((pr) =>
      [`${pr.number}`, pr.branch ?? `fix/999-${pr.number}`, pr.author ?? LOOP_ACCOUNT, ...pr.labels]
        .join(FIELD)
        .replaceAll("'", "'\\''"),
    )
    .join("\\n");
}

/** その盤面で走らせる。 */
function run(board: Board) {
  const workspace = mkdtempSync(join(tmpdir(), "stop-cleared-"));
  sandboxes.push(workspace);
  mkdirSync(join(workspace, "bin"), { recursive: true });
  for (const name of SCRIPTS) {
    const target = join(workspace, "bin", name);
    copyFileSync(join(REPO_ROOT, "bin", name), target);
    chmodSync(target, 0o755);
  }
  if (board.stop !== undefined) {
    mkdirSync(join(workspace, "loop"), { recursive: true });
    writeFileSync(join(workspace, "loop", "STOP"), `${board.stop}\n`);
  }

  const stub = join(workspace, "stub");
  mkdirSync(stub, { recursive: true });
  const numbers = (values: readonly number[]) => values.map((value) => `${value}`).join("\\n");
  writeFileSync(
    join(stub, "gh"),
    [
      "#!/usr/bin/env bash",
      // **著者の判定に要る一手**（`bin/loop-outside-author` が訊く）——**一覧とは別**
      `if [[ $* == *"api user"* ]]; then printf '%s\\n' '${LOOP_ACCOUNT}'; exit 0; fi`,
      // **落ちる側を演じる**——**「読めなかった」が「0 件」に化けないことを見る**
      `if [[ $* == *"pr list"* ]]; then`,
      ...(board.breaks === "pr" ? ["  exit 1"] : []),
      `  printf '${renderPrs(board.prs ?? [])}\\n'`,
      "  exit 0",
      "fi",
      `if [[ $* == *"--label ready"* ]]; then`,
      ...(board.breaks === "ready" ? ["  exit 1"] : []),
      `  printf '${numbers(board.ready ?? [])}\\n'`,
      "  exit 0",
      "fi",
      `if [[ $* == *"--label in-progress"* ]]; then`,
      ...(board.breaks === "in-progress" ? ["  exit 1"] : []),
      `  printf '${numbers(board.inProgress ?? [])}\\n'`,
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  return spawnSync(join(workspace, "bin/loop-stop-cleared"), [], {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
  });
}

/** `./task loop:stop` が書く形。 */
const NO_WORK = "no-work: 同じ状態が 4 回記録されたため停止。人の判断が要る";

describe("止めた理由が消えたことを、止まっている周回から出す", () => {
  it("no-work で止まっている間に open PR が来たら、そう出す", () => {
    // **これが #634 の 1 点である。** **止まっている間に PR が来ても、
    // 入口は `loop/STOP` を読んで止まるだけ**で、**理由が消えたことは出ていなかった。**
    const done = run({ stop: NO_WORK, prs: [{ number: 625, labels: [] }] });

    expect(done.status, done.stderr).toBe(0);
    expect(done.stdout, "理由が消えたと言っていない").toContain("止めた理由は消えています");
    // **件数は出す**（**どれが来たかは `./task loop:status` が出す**）
    expect(done.stdout, "何が来たのかが分からない").toContain("open PR 1 件");
  });

  it("渡せる仕事がまだ無いなら、何も言わない", () => {
    // **毎周回出ると、`loop/STOP` が「読み飛ばすもの」になる**（#634 の完了条件）
    const done = run({ stop: NO_WORK });

    expect(done.status).toBe(1);
    expect(done.stdout, "何も無いのに鳴っている").toBe("");
  });

  it("人待ちの PR しか無いなら、まだ消えていない", () => {
    // **`parked` + `awaiting-human` は、ループの中では解けない**（#546）
    // ——**数に入れると、理由は消えていないのに毎周回鳴る。**
    // **判定は `bin/loop-open-work` が持っている**（`AGENTS.md` §5）。
    const done = run({
      stop: NO_WORK,
      prs: [{ number: 625, labels: ["parked", "awaiting-human"] }],
    });

    expect(done.status, done.stdout).toBe(1);
  });

  it("ready の Issue が来たら、そう出す", () => {
    const done = run({ stop: NO_WORK, ready: [634] });

    expect(done.status, done.stderr).toBe(0);
    expect(done.stdout).toContain("ready 1 件");
  });

  it("in-progress の Issue が残っていたら、そう出す", () => {
    // **実装している最中である**——**外すと「作業が尽きた」と数える側と食い違う**
    const done = run({ stop: NO_WORK, inProgress: [629] });

    expect(done.status, done.stderr).toBe(0);
    expect(done.stdout).toContain("in-progress 1 件");
  });

  it("no-work 以外で止まっているときは、消えたと言わない", () => {
    // **止めた理由ごとに測り方が違う**（#634 の完了条件）——**`main-sync-failed` は
    // 盤面と無関係**で、**盤面が動いても消えていない。**
    for (const stop of [
      "main-sync-failed: 同じ状態が 3 回記録されたため停止。人の判断が要る",
      "procedure-stale: 同じ状態が 3 回記録されたため停止。人の判断が要る",
      "手動停止",
    ]) {
      const done = run({ stop, prs: [{ number: 625, labels: [] }] });

      expect(done.status, `${stop} で鳴っている: ${done.stdout}`).toBe(1);
    }
  });

  it("止まっていなければ、何も言わない", () => {
    // **止まっていない周回から呼ばれても黙る**——**入口の分岐を 2 箇所に持たない**
    const done = run({ prs: [{ number: 625, labels: [] }] });

    expect(done.status).toBe(1);
    expect(done.stdout).toBe("");
  });

  it("一覧を取れなかったら、「まだ仕事が無い」に化けさせない", () => {
    // **黙る側へ倒すと、読めない間ずっと人が呼ばれない**——**「読めなかった」は
    // 「0 件」ではない**（`AGENTS.md` §5。`bin/loop-open-work` と同じ向き）。
    for (const breaks of ["pr", "ready", "in-progress"] as const) {
      const done = run({ stop: NO_WORK, breaks });

      expect(done.status, `${breaks} を取れないのに判定している: ${done.stdout}`).toBe(2);
    }
  });

  it("使い方の誤りは、「言うことは無い」と混ぜない", () => {
    // **exit 1 は「見たうえで、言うことが無い」**である——**呼び方を間違えた側を
    // そこへ倒すと、入口は黙ったまま素通りする。**
    const workspace = mkdtempSync(join(tmpdir(), "stop-cleared-"));
    sandboxes.push(workspace);
    const done = spawnSync(join(REPO_ROOT, "bin/loop-stop-cleared"), ["余計な引数"], {
      cwd: workspace,
      encoding: "utf8",
    });

    expect(done.status).toBe(2);
  });
});
