/**
 * **保留した PR の枠を、master も同じ数え方で引くこと** (#318)。
 *
 * **判定は `bin/loop-parked-issues` が 1 つだけ持つ。** **出口（`bin/loop-handoff`）と
 * master のステップ 6 が同じ数え方を書いていた**ので、**片方だけ直すと食い違う**
 * （`AGENTS.md` §5）——**出口だけ直しても、`ready` へ昇格させる側は
 * 「着手中 1 件」と数え続ける。**
 *
 * **「書いてある」ではなく「走る」を見る**（`loop/promotable-wiring.test.ts` と同じ形）。
 * **散文に「`Closes` が無くても引く」と書いても、打つコマンドが `Closes` しか
 * 見ていなければ、実行する側には引く材料が無い**（#313 で実際に踏んだ形）。
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROCEDURE = ".claude/commands/loop-master.md";

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/** その節の bash ブロック（**打つところで見る**）。 */
function blocks(text: string): string[] {
  return text
    .split("```bash")
    .slice(1)
    .map((chunk) => chunk.split("```")[0] ?? "");
}

/** 保留した PR。**`Closes` を書いていない**（割った PR は親を閉じない）。 */
const PARKED_WITHOUT_CLOSES = {
  number: 317,
  labels: ["parked", "awaiting-human"],
  body: "#315 の 1/3。認可の土台だけを入れる",
};

/**
 * 保留の枠を数えるブロックを、偽の `gh` で走らせる。
 *
 * **本物の `bin/loop-parked-issues` を置く**——**判定を写した偽物を置くと、
 * 判定が変わったことに気づけない。**
 */
function runCount(): { status: number; stdout: string; stderr: string } {
  // **取る側と数える側を、続けて打つ**（**手順書はブロックを分けている**——
  // **片方だけ走らせると、いちばん見たい繋ぎ目が抜ける**）
  const block = blocks(read(PROCEDURE).split("## 6. 着手順を決める")[1] ?? "")
    .filter((chunk) => /parked(_slots)?="/.test(chunk))
    .join("\n");
  const workspace = mkdtempSync(join(tmpdir(), "parked-slots-"));
  try {
    const stub = join(workspace, "stub");
    mkdirSync(stub, { recursive: true });
    mkdirSync(join(workspace, "bin"), { recursive: true });
    copyFileSync(
      join(REPO_ROOT, "bin/loop-parked-issues"),
      join(workspace, "bin/loop-parked-issues"),
    );
    // **落ちたら停止を積む側も偽物にする**（本物を呼ぶと、試験がカウンタを動かす）
    writeFileSync(
      join(workspace, "bin/loop-stall"),
      ["#!/usr/bin/env bash", 'echo "stall $*" >&2', "exit 0", ""].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(
      join(stub, "gh"),
      [
        "#!/usr/bin/env bash",
        // **番号・label・本文を取っていること。** 取っていなければ、
        // **どの PR が保留で、何を閉じる予定かを、数える側が判別できない**
        'if [[ $* == *"--state open"* ]]; then',
        "  for field in number labels body; do",
        '    [[ $* == *"$field"* ]] || { echo "スタブ: PR の $field を取っていない: $*" >&2; exit 1; }',
        "  done",
        // **本物と同じ形で返す**（US 区切り。`bin/loop-handoff` と揃えてある）
        `  printf '%s\\037%s\\037%s\\n' ${PARKED_WITHOUT_CLOSES.number} ${PARKED_WITHOUT_CLOSES.labels.join(",")} '${PARKED_WITHOUT_CLOSES.body}'`,
        "  exit 0",
        "fi",
        `printf '%s\\n' '[]'`,
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync("bash", ["-c", block], {
      cwd: workspace,
      encoding: "utf8",
      env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
    });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

describe("保留した PR の枠を、master も引く", () => {
  it("`Closes` が無い保留 PR でも、引く枠として出る", () => {
    // **これが出ないと、`in-progress` は減らない**——**ready 0 / backlog 0 で
    // worker が待っていても `no-work` に入らず、3 周で人を呼ぶ経路に乗らない**
    const counted = runCount();

    expect(counted.stderr, `ブロックが落ちている: ${counted.stderr}`).not.toContain("スタブ:");
    expect(counted.status).toBe(0);
    expect(counted.stdout.trim(), "保留 PR の枠が 1 件も出ていない").not.toBe("");
  });

  it("数え方は、出口と同じものを呼ぶ", () => {
    // **写しを持たない**（`AGENTS.md` §5）。**両方が同じスクリプトを呼ぶ**
    const step6 = read(PROCEDURE).split("## 6. 着手順を決める")[1] ?? "";

    expect(step6, "master が自分で数えている").toContain("bin/loop-parked-issues");
    expect(read("bin/loop-handoff"), "出口が自分で数えている").toContain("loop-parked-issues");
  });
});
