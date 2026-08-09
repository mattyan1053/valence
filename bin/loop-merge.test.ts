import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-merge", import.meta.url));

/** テストが渡す「ゲートが検証した SHA」。 */
const GATED_SHA = "a".repeat(40);

type Run = { status: number; stdout: string; stderr: string };
/** gh へ渡された引数列も見る。安全装置が消えたことに気づけるようにする。 */
type FakeRun = Run & { calls: string[] };

/** bash だけを置いた PATH。gh がここに無いので、到達すれば別の失敗になる。 */
let binDir: string;

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "loop-merge-bin-"));
  symlinkSync("/usr/bin/bash", join(binDir, "bash"));
});

afterAll(() => {
  rmSync(binDir, { recursive: true, force: true });
});

/**
 * 検証だけを通す（gh を呼ばせない）。
 * 引数の検査が gh の実行より前にあることが前提で、後ろにあるとこのテストが
 * 本当にマージを試みてしまう。**壊れたら落ちる形にしてある。**
 */
function run(args: string[]): Run {
  const result = spawnSync(SCRIPT, args, {
    encoding: "utf8",
    env: { ...process.env, PATH: binDir },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/**
 * gh を差し替えて判定だけを動かす。**この判定こそが本題**で、
 * 実際にマージしてしまうため本物の gh では試せない。
 */
function runWithFakeGh(
  prFields: string[],
  mergeExit: number,
  /** remote ブランチの見え方。削除の反映には数秒かかることがある。 */
  branchRef:
    | "gone"
    | "always-there"
    | "gone-after-retry"
    | "cannot-tell"
    | "exists-then-cannot-tell" = "gone",
  extraEnv: Record<string, string> = {},
): FakeRun {
  const dir = mkdtempSync(join(tmpdir(), "loop-merge-fake-"));
  symlinkSync("/usr/bin/bash", join(dir, "bash"));
  const callLog = join(dir, "calls");
  writeFileSync(
    join(dir, "gh"),
    [
      "#!/usr/bin/env bash",
      // 何をどう呼んだかを残す。呼び出しの中身を見ないと、安全装置が
      // 実装から消えても全部通ってしまう
      `printf '%s\\n' "$*" >> '${callLog}'`,
      'if [[ $1 == "pr" && $2 == "merge" ]]; then',
      '  echo "could not determine current branch: not on any branch" >&2',
      `  exit ${mergeExit}`,
      "fi",
      // remote ブランチの存在確認。何度目の問い合わせかで応答を変える
      'if [[ $1 == "api" ]]; then',
      // cat は組み込みではないので使わない（PATH に置いていない）
      "  n=0",
      `  [[ -f '${dir}/apicalls' ]] && read -r n < '${dir}/apicalls'`,
      "  n=$((n + 1))",
      `  echo "$n" > '${dir}/apicalls'`,
      // gh は失敗の理由を問わず 1 を返す。404（消えた）とそれ以外を本文で分ける
      ...(branchRef === "always-there"
        ? ["  exit 0"]
        : branchRef === "gone-after-retry"
          ? [
              "  if ((n == 1)); then exit 0; fi",
              '  echo "gh: Not Found (HTTP 404)" >&2',
              "  exit 1",
            ]
          : branchRef === "cannot-tell"
            ? ['  echo "error connecting to api.github.com" >&2', "  exit 1"]
            : branchRef === "exists-then-cannot-tell"
              ? [
                  "  if ((n == 1)); then exit 0; fi",
                  '  echo "error connecting to api.github.com" >&2',
                  "  exit 1",
                ]
              : ['  echo "gh: Not Found (HTTP 404)" >&2', "  exit 1"]),
      "fi",
      'if [[ $1 == "pr" && $2 == "view" ]]; then',
      // --jq は gh 側で解決されるので、差し替えでは取り出し済みの値を 1 行 1 値で返す
      ...prFields.map((value) => `  echo '${value}'`),
      "  exit 0",
      "fi",
      // remote ブランチの存在確認。消えている前提にする
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const result = spawnSync(SCRIPT, ["12", GATED_SHA], {
    encoding: "utf8",
    // 反映待ちで実時間を使わない
    env: { ...process.env, PATH: dir, LOOP_BRANCH_CHECK_WAIT_SEC: "0", ...extraEnv },
  });
  const calls = existsSync(callLog)
    ? readFileSync(callLog, "utf8")
        .split("\n")
        .filter((line) => line !== "")
    : [];
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr, calls };
}

describe("bin/loop-merge の成否判定", () => {
  it("gh が非ゼロでも、マージされていれば成功として返す", () => {
    // detached HEAD の worktree で毎回起きる姿。終了コードだけ見ると誤判定する
    const result = runWithFakeGh(
      ["MERGED", "2026-08-08T22:21:40Z", "6e8a472", "feat/x", GATED_SHA],
      1,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("MERGED pr=12 commit=6e8a472");
    // 何が起きたかは残す。黙って隠すと本物の異常に気づけない
    expect(result.stdout).toContain("gh は exit 1 で終了しましたが");
  });

  it("gh が成功しても、マージされていなければ失敗として返す", () => {
    const result = runWithFakeGh(["OPEN", "", "", "feat/x", GATED_SHA], 0);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("マージされていません (state=OPEN)");
  });

  it("マージはゲートした SHA に固定して要求する", () => {
    // --match-head-commit が、ゲート後に push された未検証 commit のマージを防ぐ唯一の装置。
    // 呼び出しの中身を見ないと、実装から消えてもどのテストも落ちない
    const result = runWithFakeGh(
      ["MERGED", "2026-08-08T22:21:40Z", "6e8a472", "feat/x", GATED_SHA],
      0,
    );

    const mergeCall = result.calls.find((call) => call.startsWith("pr merge"));

    expect(mergeCall).toBe(`pr merge 12 --squash --delete-branch --match-head-commit ${GATED_SHA}`);
  });

  it("削除の反映が遅れているだけなら、ブランチ残りの警告を出さない", () => {
    // --delete-branch の削除が GitHub 側へ反映される前に読むと、まだ ref が見える。
    // **毎回出る警告は読まれなくなる**ので、本当に残ったときに気づけなくなる
    const result = runWithFakeGh(
      ["MERGED", "2026-08-08T22:21:40Z", "6e8a472", "feat/x", GATED_SHA],
      0,
      "gone-after-retry",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("remote ブランチが残っています");
  });

  it("待っても残っているブランチは警告する", () => {
    const result = runWithFakeGh(
      ["MERGED", "2026-08-08T22:21:40Z", "6e8a472", "feat/x", GATED_SHA],
      0,
      "always-there",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("remote ブランチが残っています: feat/x");
  });

  it("確認できなかっただけの失敗を、ブランチが消えたと扱わない", () => {
    // gh は通信エラーや rate limit でも 1 を返す。**「分からない」を「大丈夫」に丸めない**
    const result = runWithFakeGh(
      ["MERGED", "2026-08-08T22:21:40Z", "6e8a472", "feat/x", GATED_SHA],
      0,
      "cannot-tell",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("確認できませんでした");
  });

  it("存在を確認したあと判定できなくなったら、残っている側に倒す", () => {
    const result = runWithFakeGh(
      ["MERGED", "2026-08-08T22:21:40Z", "6e8a472", "feat/x", GATED_SHA],
      0,
      "exists-then-cannot-tell",
    );

    expect(result.stdout).toContain("remote ブランチが残っています: feat/x");
  });

  it("ゲートした SHA と違う head がマージされていたら成功にしない", () => {
    // ゲート後に別の commit が push され、人が UI から手でマージした場合。
    // --match-head-commit はこちらのマージ要求にしか効かないので、state だけ見ると
    // **ゲートしていない head を成功として扱う**
    const result = runWithFakeGh(
      ["MERGED", "2026-08-08T22:21:40Z", "6e8a472", "feat/x", "b".repeat(40)],
      1,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ゲートした SHA");
  });

  it("mergedAt が無ければ MERGED でも信用しない", () => {
    const result = runWithFakeGh(["MERGED", "", "", "feat/x", GATED_SHA], 0);

    expect(result.status).toBe(1);
  });
});

describe("bin/loop-merge の設定検査", () => {
  /** 設定だけを見る（gh を呼ばせない）。 */
  function runWithConfig(wait: string): Run {
    const result = spawnSync(SCRIPT, ["12", GATED_SHA], {
      encoding: "utf8",
      env: { ...process.env, PATH: binDir, LOOP_BRANCH_CHECK_WAIT_SEC: wait },
    });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  it("待ち時間が非負整数でなければ落ちる", () => {
    // 算術評価でエラーになる値。sleep が呼ばれず、誤警告が設定次第で戻る
    expect(runWithConfig("0.5").status).toBe(2);
    expect(runWithConfig("foo").status).toBe(2);
    expect(runWithConfig("-1").status).toBe(2);
    expect(runWithConfig("0.5").stderr).toContain("LOOP_BRANCH_CHECK_WAIT_SEC");
  });

  it("先頭に 0 が付いていても 10 進として受け付ける", () => {
    // 08 を 8 進として読むと算術エラーになる
    expect(runWithConfig("08").status).not.toBe(2);
  });

  it("設定が誤っていたら、マージを試みる前に落ちる", () => {
    // マージは取り消せない。**その後で落ちると成功したマージが失敗として記録される**
    const result = runWithFakeGh(
      ["MERGED", "2026-08-08T22:21:40Z", "6e8a472", "feat/x", GATED_SHA],
      0,
      "gone",
      { LOOP_BRANCH_CHECK_WAIT_SEC: "0.5" },
    );

    expect(result.status).toBe(2);
    expect(result.calls).toEqual([]);
  });
});

describe("bin/loop-merge の入力検査", () => {
  it("引数が足りなければ使い方を出して落ちる", () => {
    const result = run(["12"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("使い方");
  });

  it("PR 番号が数字でなければ落ちる", () => {
    expect(run(["../12", "a".repeat(40)]).status).toBe(2);
    expect(run(["", "a".repeat(40)]).status).toBe(2);
  });

  it("head SHA が 40 桁の 16 進でなければ落ちる", () => {
    // 短縮 SHA は --match-head-commit が受け付けない。曖昧なまま渡さない
    expect(run(["12", "a".repeat(7)]).status).toBe(2);
    expect(run(["12", "main"]).status).toBe(2);
    expect(run(["12", ""]).status).toBe(2);
  });

  it("入力の検査は gh を呼ぶ前に終わる", () => {
    // gh の無い PATH で「gh が無い」ではなく入力の誤りとして落ちること
    const result = run(["12", "zz"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("head SHA");
    expect(result.stderr).not.toContain("gh");
  });
});
