import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-open-requests", import.meta.url));

type Run = { status: number; stdout: string; stderr: string };

/** bash だけを置いた PATH。gh がここに無いので、到達すれば別の失敗になる。 */
let binDir: string;

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "loop-open-requests-bin-"));
  symlinkSync("/usr/bin/bash", join(binDir, "bash"));
});

afterAll(() => {
  rmSync(binDir, { recursive: true, force: true });
});

/** 入力検査だけを通す（gh を呼ばせない）。 */
function run(args: string[]): Run {
  const result = spawnSync(SCRIPT, args, {
    encoding: "utf8",
    env: { ...process.env, PATH: binDir },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** gh を差し替え、PR に付いている label を 1 行ずつ返させる。 */
function runWithLabels(labels: string[], ghExit = 0): Run {
  const dir = mkdtempSync(join(tmpdir(), "loop-open-requests-fake-"));
  symlinkSync("/usr/bin/bash", join(dir, "bash"));
  writeFileSync(
    join(dir, "gh"),
    [
      "#!/usr/bin/env bash",
      ...labels.map((label) => `printf '%s\\n' ${JSON.stringify(label)}`),
      `exit ${ghExit}`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const result = spawnSync(SCRIPT, ["12"], {
    encoding: "utf8",
    env: { ...process.env, PATH: dir },
  });
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe("bin/loop-open-requests の判定", () => {
  it("label が付いていなければ、未処理の要求なしとして 0 を返す", () => {
    const result = runWithLabels([]);

    expect(result.status).toBe(0);
  });

  it("changes-requested が付いていれば 1 を返す", () => {
    // **master が通常コメントで返した要求は、レビュースレッドとして残らない。**
    // label に落とさないと、止めているのは master の記憶だけになる
    const result = runWithLabels(["changes-requested"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("changes-requested");
  });

  it("他の label が並んでいても見落とさない", () => {
    const result = runWithLabels(["parked", "changes-requested", "bug"]);

    expect(result.status).toBe(1);
  });

  it("名前が似ているだけの label は数えない", () => {
    // 前方一致で拾うと、**要求が無いのに永久に止まる** label を作れてしまう
    const result = runWithLabels(["changes-requested-later", "requested", "changes"]);

    expect(result.status).toBe(0);
  });

  it("label を取得できなければ、要求なしと扱わずに 2 を返す", () => {
    // **判定不能を合格に倒さない。** ここを 0 にすると、API 障害の周回だけ
    // master の要求が消えてマージが通る
    const result = runWithLabels([], 1);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("取得できません");
  });
});

describe("bin/loop-open-requests の入力検査", () => {
  it("引数が無ければ使い方を出して落ちる", () => {
    const result = run([]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("使い方");
  });

  it("PR 番号が数字でなければ落ちる", () => {
    expect(run(["../12"]).status).toBe(2);
    expect(run([""]).status).toBe(2);
  });

  it("入力の検査は gh を呼ぶ前に終わる", () => {
    // gh の無い PATH で「gh が無い」ではなく入力の誤りとして落ちること
    const result = run(["abc"]);

    expect(result.status).toBe(2);
    expect(result.stderr).not.toContain("gh");
  });
});
