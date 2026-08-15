/**
 * **ステップ 2.2 の「OPEN（`parked` でない）」は、持ち主を確かめてから決める**（#80）。
 *
 * **`in-progress` の記録と PR の記録は、別々に期限切れする。** **PR ができたあと、
 * Issue 側の記録を更新する経路は無い**（持ち主はステップ 3 の `bin/loop-claim pr` しか
 * 通らない）ので、**PR が立った 30 分後には、Issue 側の記録だけが必ず空く。**
 *
 * **すると `bin/loop-claim resume` は exit 0（引き継ぎ）を返す**——**PR は別の作業場が
 * 現に直しているのに**である。前の版はその先で「他人が作った PR など」と決めつけ、
 * **`implementation-blocked` を積んでいた**。**もう一方が正常にレビュー対応している間、
 * こちらは毎周回それを積む**ので、**3 周で `loop/STOP` が配られ、全ループが止まる。**
 *
 * **1 人では起きない。** **PR を持っている作業場自身はステップ 2.1 で自分の PR を
 * 見つけてステップ 3 へ行く**ので、2.2 に入らない——**2 人目ができて初めて踏む。**
 * **#80 が開ける栓の、すぐ内側にあった。**
 *
 * **散文だけに書かない**（#237）。**行き先を下に並べても、ブロックに分岐が無ければ
 * 積まれる**ので、**ブロックをそのまま走らせて確かめる。**
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROCEDURE = ".claude/commands/loop-worker.md";

/** この試験が使う番号。**手順書の穴埋めをそのまま置き換える。** */
const PR = "42";
const ISSUE = "7";

/** 手順書の bash ブロックを全部取り出す。**書き写さない**（写すと、直さなくても緑になる）。 */
function bashBlocks(): string[] {
  const body = readFileSync(join(REPO_ROOT, PROCEDURE), "utf8");
  return [...body.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
}

/**
 * **OPEN の PR をどう扱うかを決めているブロック。**
 *
 * **名指しの見出しで探さない**（#173 / head-wiring と同じ理由）——**節を割ったり
 * 文言を変えたりしただけで、試験が黙る。** **中身で見つける。**
 */
function openPrBlocks(): string[] {
  return bashBlocks().filter(
    (block) => block.includes("implementation-blocked:") && block.includes("bin/loop-claim pr"),
  );
}

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

type Run = {
  /** `bin/loop-stall` に渡された識別子（呼ばれていなければ空）。 */
  stalled: string[];
  status: number;
};

/**
 * ブロックをそのまま走らせる。**外に出るものは全部差し替える。**
 *
 * - `gh` … 自分の open PR の番号を返す（`ghExit` で失敗も作れる）
 * - `bin/loop-claim` … 持ち主の判定（`claimExit`）
 * - `bin/loop-stall` … 積まれた識別子を記録するだけ
 */
function runBlock(
  block: string,
  options: { claimExit: number; ownPrs?: string[]; ghExit?: number },
): Run {
  const { claimExit, ownPrs = [PR], ghExit = 0 } = options;
  const workspace = mkdtempSync(join(tmpdir(), "open-pr-owner-"));
  workspaces.push(workspace);
  const bin = join(workspace, "bin");
  mkdirSync(bin, { recursive: true });
  const stallLog = join(workspace, "stalled");
  writeFileSync(stallLog, "");

  writeFileSync(
    join(bin, "loop-claim"),
    ["#!/usr/bin/env bash", `exit ${claimExit}`, ""].join("\n"),
    {
      mode: 0o755,
    },
  );
  writeFileSync(
    join(bin, "loop-stall"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(stallLog)}`,
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const stub = join(workspace, "stub");
  mkdirSync(stub, { recursive: true });
  writeFileSync(
    join(stub, "gh"),
    [
      "#!/usr/bin/env bash",
      ...ownPrs.map((number) => `printf '%s\\n' ${JSON.stringify(number)}`),
      `exit ${ghExit}`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const script = block.replaceAll("<PR番号>", PR).replaceAll("<Issue番号>", ISSUE);
  const result = spawnSync("bash", ["-c", script], {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
  });

  return {
    stalled: readFileSync(stallLog, "utf8").split("\n").filter(Boolean),
    status: result.status ?? -1,
  };
}

describe("in-progress のまま OPEN の PR があるとき、持ち主を確かめる", () => {
  it("判定しているブロックが 1 つ見つかる", () => {
    // **0 件でも「全部が満たしている」は真になる**——**空振りを緑にしない。**
    expect(openPrBlocks().length, "OPEN の PR を扱うブロックが見当たらない").toBe(1);
  });

  const [block] = openPrBlocks();

  it("別の作業場が直しているなら、停止を積まない", () => {
    // **これが本題。** **積むと、もう一方が正常に直している間に 3 周で `loop/STOP`**
    expect(
      runBlock(block ?? "", { claimExit: 1 }).stalled,
      "別の作業場が直しているのに停止を積んでいる",
    ).toEqual([]);
  });

  it("持ち主が居なければ引き継ぎ、停止を積まない", () => {
    const run = runBlock(block ?? "", { claimExit: 0 });

    expect(run.stalled, "引き継いだのに停止を積んでいる").toEqual([]);
    // **止めすぎていないこと。** **この先（ステップ 3）へ進める**
    expect(run.status, "引き継いだのに落ちている").toBe(0);
  });

  it("他人が作った PR なら、これまでどおり停止を積む", () => {
    // **前からある担保を落とさない。** **自分の open PR に出てこないなら、推測で触らない**
    expect(
      runBlock(block ?? "", { claimExit: 0, ownPrs: ["999"] }).stalled,
      "他人が作った PR を触っている",
    ).toEqual([`implementation-blocked:${ISSUE}`]);
  });

  it("自分の PR を数えられなければ、0 件と読まずに記録する", () => {
    // **取れなかったものを「他人の PR」と読まない**（#136 と同じ形）
    expect(
      runBlock(block ?? "", { claimExit: 0, ghExit: 1 }).stalled,
      "取得に失敗したのに黙って進んでいる",
    ).toEqual(["pr-lookup-failed"]);
  });

  it("判定できないときは、触らずに終わる", () => {
    // **`exit 2` と、判定器が消えた 126 / 127 を同じ側へ倒す**
    for (const claimExit of [2, 127]) {
      const run = runBlock(block ?? "", { claimExit });

      expect(run.stalled, `exit ${claimExit} で停止を積んでいる`).toEqual([]);
      expect(run.status, `exit ${claimExit} なのに先へ進んでいる`).not.toBe(0);
    }
  });
});
