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
function runWithFakeGh(prFields: string[], mergeExit: number): FakeRun {
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
    env: { ...process.env, PATH: dir },
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
