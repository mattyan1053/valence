import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/**
 * 人の判断待ちで、ループ全体が止まらないようにする（#109）。
 *
 * **待つこと自体は正しい。** 問題は**待っている間に他の作業まで止まる**ことで、
 * **同時に open な PR は 1 本・worker は 1 人**なので、**1 件の人待ちがそのまま全停止**になる。
 * 実測で**約 2 時間、どちらのループも何も進めなかった**（#158）。
 */
describe("人の判断待ち", () => {
  /** master の手順書のうち、人を呼ぶ段。 */
  function humanBranch(): string {
    return (
      read(".claude/commands/loop-master.md")
        .split("#### human — 人を呼ぶ")[1]
        ?.split("\n#### ")[0] ?? ""
    );
  }

  it("人を呼ぶときは、PR を保留にする", () => {
    // **保留にしないと、worker は次の PR を作れず、master は次を `ready` にできない**——
    // **紐づく Issue が `in-progress` のまま残る**ため。**両側で外して初めて経路が通る**
    const branch = humanBranch();

    expect(branch).toContain("--add-label");
    expect(branch).toContain("parked");
    expect(branch).toContain("awaiting-human");
  });

  it("人待ちでは、停止を数えない", () => {
    // **進めるようにしたのに `loop/STOP` に到達しては意味が無い。**
    // **数えない側へ倒した理由**を、手順書に残していること
    const branch = humanBranch();

    expect(branch).toMatch(/数えない|記録しない/);
    expect(branch, "倒した理由が書かれていない").toMatch(/loop\/STOP|止ま/);
  });

  it("誰が戻すのかが書いてある", () => {
    // **戻せるのが master だけなら、master が忘れると永久に止まる**（#109 の懸念）。
    // **人が外す**——判断した本人が、その場で戻せる形にする
    expect(humanBranch()).toMatch(/人が.*外す|人が.*戻/);
  });

  it("待っている相手を、PR に書くと定めている", () => {
    // **先行 PR を待つ場合と混ざると、何を待っているのか分からない `parked` が残る**
    expect(humanBranch()).toMatch(/何が決まれば/);
  });

  it("./task loop:status が、人待ちの PR を見せる", () => {
    // **止まっている理由が読めること**（#157 と同じ）。
    // **人待ちのまま忘れられる経路を作らない**ための、唯一の見える場所である
    const workspace = mkdtempSync(join(tmpdir(), "awaiting-human-"));
    try {
      expect(spawnSync("git", ["init", "--quiet", workspace]).status).toBe(0);
      const stub = join(workspace, "stub");
      mkdirSync(stub, { recursive: true });
      writeFileSync(
        join(stub, "gh"),
        [
          "#!/usr/bin/env bash",
          // **人待ちの一覧だけを返す。** 他の口は空でよい
          'if [[ $* == *"awaiting-human"* ]]; then',
          '  echo "  #158 材料が遅いときも縮退する"',
          "  exit 0",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      const shown = execFileSync(
        "bash",
        [
          "-c",
          `source ${JSON.stringify(join(REPO_ROOT, "task"))} >/dev/null 2>&1; ` +
            `cd ${JSON.stringify(workspace)}; ` +
            `PATH=${JSON.stringify(stub)}:$PATH cmd_loop_status`,
        ],
        { encoding: "utf8" },
      );

      expect(shown, "人待ちが見えない").toContain("158");
      expect(shown).toMatch(/人の判断待ち|awaiting-human/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
