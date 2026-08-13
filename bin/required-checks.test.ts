/**
 * **`bin/loop-ci-status` が待つ名前と、CI が実際に出す名前が同じであること。**
 *
 * **ゲートは名前で待つ。** **一覧に無い job は、落ちていても待たれない**ので、
 * **赤いまま通る**。**一覧にしか無い名前は、永久に来ない**ので、
 * **master は毎周回「正しく何もしない」を選び続ける** (#206 で実際に 105 分止まった)。
 *
 * **どちらへ倒れても分かるようにする。** **片側だけを見ると、増やしたときと
 * 消したときで、気づけるのが片方だけになる。**
 *
 * **人の手順にしない。** 「必須チェックを増やしたら一覧にも足すこと」は書いてあっても
 * 飛ばされる——**飛ばされたことは、次に CI が落ちたとき初めて分かる。**
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-ci-status", import.meta.url));
const WORKFLOW_DIR = fileURLToPath(new URL("../.github/workflows", import.meta.url));

/**
 * workflow 1 つが GitHub へ出す検査の名前を拾う。
 *
 * **`name:` を書かない job は、job の id がそのまま名前になる** (GitHub の規則)。
 * **書いてあるほうだけを拾うと、名前のない job が「存在しない」ことになる。**
 */
function checkNamesIn(workflow: string): string[] {
  const names: string[] = [];
  let inJobs = false;
  let current: string | undefined;
  for (const line of workflow.split("\n")) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) {
      continue;
    }
    // **jobs: の外へ出たら終わり。** インデントの無い行は別の最上位キーである。
    if (/^\S/.test(line)) {
      break;
    }
    const job = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (job?.[1] !== undefined) {
      current = job[1];
      names.push(current);
      continue;
    }
    const named = /^ {4}name:\s*(\S.*?)\s*$/.exec(line);
    if (named?.[1] !== undefined && current !== undefined) {
      names[names.length - 1] = named[1];
      current = undefined;
    }
  }
  return names;
}

function checkNamesInWorkflows(): string[] {
  const files = readdirSync(WORKFLOW_DIR).filter((name) => /\.ya?ml$/.test(name));
  return files.flatMap((file) => checkNamesIn(readFileSync(join(WORKFLOW_DIR, file), "utf8")));
}

function requiredChecks(): string[] {
  const run = spawnSync(SCRIPT, ["--required-checks"], { encoding: "utf8" });
  expect(run.status, run.stderr).toBe(0);
  return run.stdout.split("\n").filter((line) => line !== "");
}

describe("必須チェックの一覧", () => {
  it("`name:` を書かない job は、job の id が名前になる", () => {
    const workflow = ["on:", "  push:", "jobs:", "  build:", "    runs-on: x", ""].join("\n");
    expect(checkNamesIn(workflow)).toEqual(["build"]);
  });

  it("`name:` を書いた job は、そちらが名前になる", () => {
    const workflow = [
      "jobs:",
      "  check:",
      "    name: lint / typecheck",
      "    steps:",
      "      - name: これは step なので拾わない",
      "",
    ].join("\n");
    expect(checkNamesIn(workflow)).toEqual(["lint / typecheck"]);
  });

  it("読み取りそのものが空振りしていない", () => {
    // **0 件でも「一致」してしまう。** 読めていないことを、一致と読ませない。
    expect(checkNamesInWorkflows().length).toBeGreaterThan(1);
  });

  it("CI が出す名前と、待つ名前が同じである", () => {
    expect([...requiredChecks()].sort()).toEqual([...checkNamesInWorkflows()].sort());
  });
});
