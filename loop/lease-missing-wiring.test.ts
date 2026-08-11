import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/**
 * 入口を飛ばした記録が、**人の目に触れる場所へ出るか**。
 *
 * **記録するだけでは終わらない。** 誰も読まない場所に積むと、
 * **「あとから分かる」は「探し方を知っている人にだけ分かる」**になる——
 * この Issue（#143）が問題にしたのは、まさに**気づけないこと**だった。
 */
describe("入口を飛ばした記録", () => {
  it("出口が飛ばしを見つけると書いてある", () => {
    // **判断はスクリプトが持つ。** ここでは「見る場所がある」ことだけを固定する
    expect(read("bin/loop-handoff")).toContain("loop-lease");
  });

  it("./task loop:status が、溜まった記録を見せる", () => {
    // **見えなければ、記録は無いのと同じ。** 溜まっていることが分かるのは、
    // **周回のたびに読む場所**に出たときだけである。
    //
    // **関数を直接呼んで確かめない。** それだと**呼び出しを外しても緑のまま**になる
    // （実際に変異で通ってしまった）——**見たいのは「配線されていること」**である
    const workspace = mkdtempSync(join(tmpdir(), "lease-missing-"));
    try {
      expect(spawnSync("git", ["init", "--quiet", workspace]).status).toBe(0);
      appendFileSync(
        join(workspace, ".git", "valence-loop-lease-missing"),
        "2026-08-11T20:00:00Z\tworker\t/somewhere\n",
      );
      // **`gh` は呼ばせない。** 見たいのは記録の出方で、GitHub の中身ではない
      const stub = join(workspace, "stub");
      mkdirSync(stub, { recursive: true });
      writeFileSync(join(stub, "gh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

      const shown = execFileSync(
        "bash",
        [
          "-c",
          // **`task` は読み込むと自分でリポジトリ根へ移動する。** 先に読み込んでから、
          // 見たい作業場へ入る（順番を逆にすると、実リポジトリの記録を読む）
          `source ${JSON.stringify(join(REPO_ROOT, "task"))} >/dev/null 2>&1; ` +
            `cd ${JSON.stringify(workspace)}; ` +
            `PATH=${JSON.stringify(stub)}:$PATH cmd_loop_status`,
        ],
        { encoding: "utf8" },
      );

      expect(shown).toContain("worker");
      expect(shown).toMatch(/lease/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("記録が無ければ、何も言わない", () => {
    // **静かなときに騒がない。** 毎周回読む場所なので、
    // **無い状態が「異常なし」だと一目で分かる**必要がある
    const workspace = mkdtempSync(join(tmpdir(), "lease-missing-"));
    try {
      expect(spawnSync("git", ["init", "--quiet", workspace]).status).toBe(0);
      const shown = execFileSync(
        "bash",
        [
          "-c",
          // **`task` は読み込むと自分でリポジトリ根へ移動する。** 先に読み込んでから、
          // 見たい作業場へ入る（順番を逆にすると、実リポジトリの記録を読む）
          `source ${JSON.stringify(join(REPO_ROOT, "task"))} >/dev/null 2>&1; ` +
            `cd ${JSON.stringify(workspace)}; show_missing_lease`,
        ],
        { encoding: "utf8" },
      );

      expect(shown).toBe("");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
