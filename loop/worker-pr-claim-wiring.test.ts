/**
 * **PR を編集する経路は、必ず取ってから入る**（#203）。
 *
 * **#202 で worker がどこでもブランチを掴まなくなった。** **掴んでいたときは、
 * git の worktree 排他が「同じ PR を 2 人が直す」を偶然に止めていた**——
 * **その錠が外れる。**
 *
 * **入口は 1 つではない。** レビュー対応も、保留を解いた PR の rebase も、
 * **同じ `gh pr checkout --detach` から編集へ入る**——**片方にだけ書くと、
 * もう片方から重複が入る**（`bin/loop-claim` の `resume` を足したのと同じ理由）。
 * **だから場面を並べず、入口を走査する。**
 *
 * **「呼んでいること」だけを見ない**（#237 のレビュー）。**散文に exit 1 の行き先が
 * 書いてあっても、実行されるブロックに分岐が無ければ、取れなくても次の行が走る**
 * ——**錠を作って、掛けていない**（#176 で名前を付けた形）。
 * **だから、ブロックをそのまま走らせて確かめる。**
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROCEDURE = ".claude/commands/loop-worker.md";

/** 手順書の bash ブロックを全部取り出す。**書き写さない**（写すと、直さなくても緑になる）。 */
function bashBlocks(): string[] {
  const body = readFileSync(join(REPO_ROOT, PROCEDURE), "utf8");
  return [...body.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
}

/** PR の head へ入るブロック。**ここから先が「編集する」側**である。 */
function checkoutBlocks(): string[] {
  return bashBlocks().filter((block) => block.includes("gh pr checkout --detach"));
}

const workspaces: string[] = [];

/**
 * ブロックをそのまま走らせる。**`bin/loop-claim pr` の終了コードだけを変える。**
 *
 * **手順書の続き（`bin/loop-sync-main` や `./task check`）までは走らせない。**
 * 見たいのは**取れなかったときに `gh pr checkout` へ進むかどうか**だけなので、
 * **claim と checkout の間で切る**。
 */
function runBlock(block: string, claimExit: number): { checkedOut: boolean; status: number } {
  const workspace = mkdtempSync(join(tmpdir(), "pr-claim-wiring-"));
  workspaces.push(workspace);
  const bin = join(workspace, "bin");
  mkdirSync(bin, { recursive: true });
  const checkedOut = join(workspace, "checked_out");
  writeFileSync(checkedOut, "");

  writeFileSync(
    join(bin, "loop-claim"),
    ["#!/usr/bin/env bash", `exit ${claimExit}`, ""].join("\n"),
    { mode: 0o755 },
  );
  const stub = join(workspace, "stub");
  mkdirSync(stub, { recursive: true });
  writeFileSync(
    join(stub, "gh"),
    [
      "#!/usr/bin/env bash",
      'if [[ $* == *"pr checkout"* ]]; then',
      `  printf 'x\\n' >> ${JSON.stringify(checkedOut)}`,
      "fi",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  // **checkout までで切る。** それより後ろは、この試験の対象ではない
  const upToCheckout = block.split("gh pr checkout --detach <PR番号>")[0] ?? "";
  const script = `${upToCheckout}\ngh pr checkout --detach 42\n`;
  const result = spawnSync("bash", ["-c", script.replaceAll("<PR番号>", "42")], {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
  });

  return {
    checkedOut: readFileSync(checkedOut, "utf8").length > 0,
    status: result.status ?? -1,
  };
}

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

describe("PR を編集する経路は、取ってから入る", () => {
  it("入口が見つかる", () => {
    // **0 件でも「全部が満たしている」は真になる**——**空振りを緑にしない。**
    // レビュー対応と rebase の 2 つがある
    expect(
      checkoutBlocks().length,
      "PR の head へ入るブロックが見当たらない",
    ).toBeGreaterThanOrEqual(2);
  });

  for (const [index, block] of checkoutBlocks().entries()) {
    describe(`${index + 1} つ目の入口`, () => {
      it("先に取る", () => {
        const claimAt = block.indexOf("bin/loop-claim pr");
        const checkoutAt = block.indexOf("gh pr checkout --detach");

        expect(claimAt, "取らずに PR の head へ入っている").toBeGreaterThanOrEqual(0);
        // **順番が要る。** checkout の後で取っても、**もう両方が同じ SHA に居る**
        expect(claimAt, "取る前に checkout している").toBeLessThan(checkoutAt);
      });

      it("取れたら、編集へ進む", () => {
        // **止めすぎていないこと。** **1 人で回している限り、これまでどおり通る**
        expect(runBlock(block, 0).checkedOut, "取れたのに進んでいない").toBe(true);
      });

      it("別の作業場が直しているなら、編集へ進まない", () => {
        // **これが本題**（#237 のレビュー）。**散文にだけ書いても、実行されない**
        expect(runBlock(block, 1).checkedOut, "取れていないのに checkout している").toBe(false);
      });

      it("判定できないときも、編集へ進まない", () => {
        // **`exit 1` と `exit 2` は行き先が違う**が、**どちらも「編集しない」側**である
        expect(runBlock(block, 2).checkedOut, "判定できないのに checkout している").toBe(false);
      });

      it("知らない終わり方でも、編集へ進まない", () => {
        // **判定器が消えた・実行できない（126 / 127）ときに、どの分岐にも入らない形にしない**
        expect(runBlock(block, 127).checkedOut, "知らない終わり方で checkout している").toBe(false);
      });
    });
  }
});
