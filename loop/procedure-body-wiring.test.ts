/**
 * **手順書を直すたびに、走っているセッションの本文が古くなる**（#319）。
 *
 * `/loop <間隔> /loop-worker` は、**登録した時点の本文を cron で再生する**——
 * **ディスクの `.claude/commands/loop-worker.md` を毎回読み直すわけではない。**
 * **実測（2026-08-15）で `loop-worker.md` は 1 日に 5 回変わり**、
 * **worker-1 は 1 時間に 4 回、版ずれで周回を捨てた。**
 *
 * **検出（#241 / #243）は正しい。** **古い手順で走るほうが危ない**ので、
 * **変えるのは頻度である**——**本体を、cron が運ぶ本文から外す。**
 *
 * **ここは「入口が入口のままか」を見る。** **本体が入口へ戻ってくると、
 * 運ばれる本文が元の長さに戻り、この直しは黙って効かなくなる。**
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = join(REPO_ROOT, ".claude/commands/loop-worker.md");
const BODY = join(REPO_ROOT, "loop/procedure/worker.md");

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function entry(): string {
  return readFileSync(ENTRY, "utf8");
}

describe("入口だけが cron に運ばれる", () => {
  it("入口が、本体をディスクから読む口を持っている", () => {
    // **入口に書く**（#243 と同じ理由）。**本体の側に「本体を読め」と書いても、
    // **読まれていないから読めていない**
    expect(entry(), "本体を読む口が入口に無い").toContain("bin/loop-procedure-body worker");
  });

  it("読めなかったら、何もせず終わると書いてある", () => {
    // **完了条件。** **入口には手順の後半が無い**ので、**読めないまま進むと
    // レビュー対応も出口も飛ばす**——**黙って古い手順で走らせない**
    const body = entry();
    const from = body.indexOf("bin/loop-procedure-body worker");
    expect(from, "本体を読む口が無い").toBeGreaterThanOrEqual(0);
    const section = body.slice(from).split("\n## ")[0] ?? "";

    expect(section, "読めなかったときの行き先が書いていない").toMatch(/何もせず終わる/);
  });

  it("入口に、本体の写しが残っていない", () => {
    // **移すだけ**である（Issue の「やらないこと」）。**写しが残ると直す先が 2 つになり、
    // **cron が運ぶ本文も元の長さに戻る**
    const text = entry();

    expect(text, "ステップ 3 の本文が入口に残っている").not.toContain(
      "## 3. レビュー指摘に対応する",
    );
    expect(text, "出口の本文が入口に残っている").not.toContain("bin/loop-handoff worker\n");
  });

  it("本体には、移した手順がそろっている", () => {
    // **移し忘れると、その手順はどこからも読まれない**——
    // **入口には見出しだけが残るので、目で見ると移したように見える**
    const text = readFileSync(BODY, "utf8");

    expect(text, "ステップ 3 が無い").toContain("## 3. レビュー指摘に対応する");
    expect(text, "ステップ 4 が無い").toContain("## 4. `ready` から 1 件を取って実装する");
    expect(text, "周回の出口が無い").toContain("### 周回の出口");
    expect(text, "ステップ 5 が無い").toContain("## 5. 空転を検出する");
  });
});

describe("本体を直しても、配られた本文は古くならない", () => {
  /**
   * 入口と本体を写した**チェックアウトの写し**を作る。**実物を触らない。**
   *
   * **スクリプトの隣から辿る**ので、**スクリプトごと写す**
   * （`bin/loop-procedure-stamp` と同じ置き方）。
   */
  function checkoutWith(bodyText: string): string {
    const dir = mkdtempSync(join(tmpdir(), "procedure-split-"));
    sandboxes.push(dir);
    mkdirSync(join(dir, "bin"), { recursive: true });
    mkdirSync(join(dir, ".claude", "commands"), { recursive: true });
    mkdirSync(join(dir, "loop", "procedure"), { recursive: true });
    const script = join(dir, "bin", "loop-procedure-stamp");
    copyFileSync(join(REPO_ROOT, "bin/loop-procedure-stamp"), script);
    chmodSync(script, 0o755);
    copyFileSync(ENTRY, join(dir, ".claude", "commands", "loop-worker.md"));
    writeFileSync(join(dir, "loop", "procedure", "worker.md"), bodyText);
    return script;
  }

  it("本体を変えても、入口の印は変わらない", () => {
    // **これが本題である。** **本体が印の材料に入っていると、直すたびに
    // 走っているセッションが版ずれで捨てられる**——**移した意味が消える**
    const before = spawnSync(checkoutWith("# 本体\n"), ["worker"], { encoding: "utf8" });
    const after = spawnSync(checkoutWith("# 本体\n\n**書き足した。**\n"), ["worker"], {
      encoding: "utf8",
    });

    expect(before.status, before.stderr).toBe(0);
    expect(after.status, after.stderr).toBe(0);
    expect(after.stdout.trim(), "本体を変えると印が変わる").toBe(before.stdout.trim());
  });
});

describe("本体の入れ替わりは、これまでどおり見つかる", () => {
  it("周回の途中で入れ替わったかを見る一覧に、本体が入っている", () => {
    // **cron が運ばなくなったのは入口の話**である（master の指摘）。
    // **ディスクの本体は同期のたびに入れ替わりうる**ので、**一覧から漏らすと
    // 「ずれても気づかない」へ倒れる**——**今度は検出そのものが消える**
    for (const role of ["worker", "master"]) {
      const listed = spawnSync(join(REPO_ROOT, "bin/loop-procedure-changed"), [
        "--role",
        role,
        "--list",
      ]);

      expect(listed.status, `${role} の一覧を出せない`).toBe(0);
      expect(String(listed.stdout), `${role} の本体が一覧に無い`).toContain(
        `loop/procedure/${role}.md`,
      );
    }
  });
});
