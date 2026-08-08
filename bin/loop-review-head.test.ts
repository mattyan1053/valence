import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-review-head", import.meta.url));

type Run = { status: number; stdout: string; stderr: string };

describe("bin/loop-review-head", () => {
  let sandbox: string;

  /** 実リポジトリの記録を汚さないよう、使い捨ての git リポジトリで動かす。 */
  function run(args: string[]): Run {
    const result = spawnSync(SCRIPT, args, { cwd: sandbox, encoding: "utf8" });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  function listed(pr: string): string[][] {
    const result = run(["--list", pr]);
    expect(result.status).toBe(0);
    return result.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.split("\t"));
  }

  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), "loop-review-head-"));
    expect(spawnSync("git", ["init", "--quiet", sandbox], { encoding: "utf8" }).status).toBe(0);
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("記録した head SHA を時刻付きで返す", () => {
    expect(run(["10", "a".repeat(40)]).status).toBe(0);

    const rows = listed("10");

    expect(rows).toHaveLength(1);
    expect(rows[0]?.[1]).toBe("a".repeat(40));
    // 応答の時刻と比べるので、ISO8601 の UTC で持つ
    expect(rows[0]?.[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("同じ PR の記録は古い順に積む", () => {
    run(["11", "b".repeat(40)]);
    run(["11", "c".repeat(40)]);

    expect(listed("11").map((row) => row[1])).toEqual(["b".repeat(40), "c".repeat(40)]);
  });

  it("PR ごとに別の記録として持つ", () => {
    run(["12", "d".repeat(40)]);

    expect(listed("12").map((row) => row[1])).toEqual(["d".repeat(40)]);
    expect(listed("13")).toEqual([]);
  });

  it("記録が無い PR は空を返す（応答は「未記録」として扱えればよい）", () => {
    const result = run(["--list", "999"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("SHA として読めないものは記録しない", () => {
    // ブランチ名や短すぎる値を記録すると、あとで head と前方一致してしまう
    expect(run(["14", "main"]).status).toBe(2);
    expect(run(["14", "abc"]).status).toBe(2);
    expect(run(["14", "../../etc/passwd"]).status).toBe(2);
    expect(listed("14")).toEqual([]);
  });

  it("PR 番号として読めないものは記録しない", () => {
    expect(run(["../15", "e".repeat(40)]).status).toBe(2);
    expect(run(["", "e".repeat(40)]).status).toBe(2);
  });

  it("記録は作業ツリーの外に置く（コミットされない）", () => {
    run(["16", "f".repeat(40)]);

    const status = spawnSync("git", ["status", "--porcelain"], { cwd: sandbox, encoding: "utf8" });

    expect(status.stdout.trim()).toBe("");
  });
});
