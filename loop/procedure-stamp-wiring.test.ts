/**
 * **配られた手順書が、ディスクより古いことがある**（#241）。
 *
 * **#227 の仕組みでは見えない。** **`bin/loop-procedure-changed` が比べているのは
 * git の commit** で、**「いま読んでいるテキストが何版か」は見ていない**——
 * **切り替えたあとは正しく「変わっていない」と答える**ので、**赤くならない。**
 *
 * **配る側は直せない**（リポジトリの外）ので、**気づけるようにする。**
 * **検出は「読んだ側が申告する」形になる**——**手順書の中に版の印を置き、
 * 読んだ印をディスクの印と突き合わせる。**
 *
 * **印が無い版が配られたら「古い」と読む**——**印を入れる前の版がそれ**である。
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
const SCRIPT = join(REPO_ROOT, "bin/loop-procedure-stamp");
const ROLES = ["worker", "master"] as const;

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function run(args: string[], cwd: string = REPO_ROOT): { status: number; stdout: string } {
  const result = spawnSync(SCRIPT, args, { cwd, encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout.trim() };
}

/**
 * 手順書を書き換えた**チェックアウトの写し**を作る。**実物を触らない。**
 *
 * **スクリプトの隣から手順書を辿る**ので、**cwd を変えるだけでは足りない**
 * ——**スクリプトごと写す**（実物と同じ置き方にする）。
 */
function checkoutWith(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "procedure-stamp-"));
  sandboxes.push(dir);
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, ".claude", "commands"), { recursive: true });
  copyFileSync(SCRIPT, join(dir, "bin", "loop-procedure-stamp"));
  chmodSync(join(dir, "bin", "loop-procedure-stamp"), 0o755);
  writeFileSync(join(dir, ".claude", "commands", "loop-worker.md"), body);
  return join(dir, "bin", "loop-procedure-stamp");
}

function runIn(script: string, args: string[]): { status: number; stdout: string } {
  const result = spawnSync(script, args, { encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout.trim() };
}

describe("配られた手順書の版を、ディスクと突き合わせる", () => {
  for (const role of ROLES) {
    it(`${role} の手順書が、自分の印を持っている`, () => {
      // **印が古いまま置かれると、正しい版を配られた周回まで止まる**ので、
      // **`./task check` で落とす**——**印は手で書くが、合っているかは機械が見る**
      const stamp = run([role]);

      expect(stamp.status, "印を計算できない").toBe(0);
      expect(stamp.stdout, "印が空である").not.toBe("");

      const body = readFileSync(join(REPO_ROOT, `.claude/commands/loop-${role}.md`), "utf8");
      expect(body, "手順書に書いてある印が、中身と合っていない").toContain(
        `<!-- 版: ${stamp.stdout} -->`,
      );
    });

    it(`${role} の印を渡すと、そのまま通る`, () => {
      // **正常な周回で鳴らない**（完了条件）
      const stamp = run([role]);

      expect(run([role, stamp.stdout]).status, "正しい印で止めている").toBe(0);
    });
  }

  it("古い印を渡したら、止まる側へ倒れる", () => {
    // **これが本題。** **配られたテキストが古いと、印も古い**
    expect(run(["worker", "0123456789ab"]).status).toBe(1);
  });

  it("印が無くても、止まる側へ倒れる", () => {
    // **印を入れる前の版が配られた形**——**「読めない」ではなく「古い」**である
    expect(run(["worker", ""]).status).toBe(1);
    expect(run(["worker", "なし"]).status).toBe(1);
  });

  it("ディスクの手順書に印が無ければ、判定できないと言う", () => {
    // **こちらは「古い」ではない**——**突き合わせる相手が無い**
    const script = checkoutWith("# 手順書\n\n印の無い版である。\n");

    expect(runIn(script, ["worker", "0123456789ab"]).status).toBe(2);
  });

  it("印は中身から決まる（手で書いた値を信じない）", () => {
    // **印だけ書き換えても、中身が違えば違う印になる**——
    // **「印を足したが、中身と関係ない」を作らない**
    const stamp = run(["worker"]);
    const script = checkoutWith(`<!-- 版: ${stamp.stdout} -->\n\n# 別の中身\n`);

    expect(runIn(script, ["worker"]).stdout, "中身が違うのに同じ印になる").not.toBe(stamp.stdout);
  });

  it("使い方の誤りは、古いと混ぜない", () => {
    expect(run([]).status).toBe(2);
    expect(run(["それ以外の役"]).status).toBe(2);
    expect(run(["worker", "印", "余計な引数"]).status).toBe(2);
  });
});

describe("ずれたときの行き先が、手順書に書いてある", () => {
  for (const role of ROLES) {
    it(`${role} の手順書が、入口で印を渡している`, () => {
      const body = readFileSync(join(REPO_ROOT, `.claude/commands/loop-${role}.md`), "utf8");

      // **入口で受ける** (#243 のレビュー)。**手順書の側に「印を突き合わせよ」と
      // 書いても、古い版にはその行が無い**——**`acquire` に渡す形にする**
      expect(body, "入口で印を渡していない").toMatch(
        new RegExp(`bin/loop-lease acquire ${role} "`),
      );
      // **2 回目の行き先まで書く**（#241 の完了条件）——**呼び直しても古い版が
      // 来たのが今回**である
      expect(body, "2 回目の行き先が書いていない").toContain("procedure-stale");

      // **この経路で `--reset` を呼ばない** (#243 のレビュー)。**消すと、次の周回が
      // 積んだぶんも一緒に消える**——**毎周回 1 に戻り、3 周へ永久に届かない**
      // （**入れた escalation を、同じ段落の 1 行が消していた**）。
      const from = body.indexOf("印がずれていたら、`acquire` は exit 3 で止まる");
      const stale = body.indexOf("procedure-stale", from);
      expect(from, "印がずれたときの段落が無い").toBeGreaterThanOrEqual(0);
      const section = body.slice(from, stale);
      // **「消す」形が残っていないこと**（**「呼ばない」と書いてある文とは別**）
      expect(section, "捨てる前にカウンタを消している（3 周に届かない）").not.toMatch(
        /--reset` *→/,
      );
      expect(section, "消さない理由が書いていない").toMatch(/--reset` を呼ばない/);
    });
  }

  it("止まる先が、識別子の一覧にある", () => {
    // **識別子を勝手に作らない。** 一覧の正は `bin/loop-stall --list` である
    const listed = spawnSync(join(REPO_ROOT, "bin/loop-stall"), ["--list"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout, "procedure-stale が一覧に無い").toContain("procedure-stale");
  });
});
