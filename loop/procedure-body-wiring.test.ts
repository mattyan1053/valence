/**
 * **手順書を直すたびに、走っているセッションの本文が古くなる**（#319。理由は
 * `bin/loop-procedure-body` の冒頭にある）。
 *
 * **ここは「入口が入口のままか」と「いつ本体を読むか」を見る。** **本体が入口へ
 * 戻ってくると、運ばれる本文が元の長さに戻り、この直しは黙って効かなくなる。**
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

/** 本体を読む節。**行き先が書かれるべきところ**である。 */
function readSection(): string {
  const text = entry();
  const from = text.indexOf("bin/loop-procedure-body worker");
  expect(from, "本体を読む口が無い").toBeGreaterThanOrEqual(0);
  return text.slice(from).split("\n## ")[0] ?? "";
}

describe("入口だけが cron に運ばれる", () => {
  it("入口が、本体をディスクから読む口を持っている", () => {
    // **入口に書く**（#243 と同じ理由）——**本体の側に書いても、読まれていない
    expect(entry(), "本体を読む口が入口に無い").toContain("bin/loop-procedure-body worker");
  });

  it("読めなかったら、押さえたぶんを返して終わると書いてある", () => {
    // **完了条件。** **入口には手順の後半が無い**ので、**読めないまま進むと
    // レビュー対応も出口も飛ばす**——**黙って古い手順で走らせない**。
    // **読むのは lease を取ったあと**なので、**返さずに終えると、この作業場は
    // 期限が切れるまで動けない**
    const section = readSection();

    expect(section, "読めなかったときの行き先が書いていない").toContain(
      "bin/loop-lease release worker",
    );
  });

  it("本体を読むのは、同期のあとである", () => {
    // **これが #323 のレビューで出た P1 である。** **同期の前に読むと、その周回が
    // 始まった時点の作業ツリーから読む**——**未マージの PR の枝に居た周回は、
    // その PR の本体をそのまま実行する。** **`bin/loop-procedure-changed` は
    // `BEFORE` の側にしか無い変更を意図して除く**（#259）ので、**赤くならない。**
    const text = entry();
    const sync = text.indexOf("bin/loop-procedure-changed --role worker");
    const read = text.indexOf("bin/loop-procedure-body worker");

    expect(sync, "同期の判定が入口に無い").toBeGreaterThanOrEqual(0);
    expect(read, "本体を読む口が無い").toBeGreaterThanOrEqual(0);
    expect(read, "同期より先に本体を読んでいる").toBeGreaterThan(sync);
  });

  it("古い checkout に閉じ込められない理由が書いてある", () => {
    // **`bin/loop-procedure-body` を持たない checkout に居ると、同期の前では落ちる**
    // ——**同期へ到達しないまま毎周回そこで止まる**（#184 / #262 と同じ形）。
    // **順序を戻す人が、この理由に必ず当たるようにする**
    expect(readSection(), "止まった状態から出られない形に触れていない").toMatch(
      /同期へ到達しない|閉じ込め/,
    );
  });

  it("入口に、本体の写しが残っていない", () => {
    // **移すだけ**である（Issue の「やらないこと」）——**写しが残ると直す先が 2 つになり、
    // **cron が運ぶ本文も元の長さに戻る**
    const text = entry();

    expect(text, "ステップ 3 の本文が入口に残っている").not.toContain(
      "## 3. レビュー指摘に対応する",
    );
    expect(text, "出口の本文が入口に残っている").not.toContain("bin/loop-handoff worker\n");
  });

  it("本体には、移した手順がそろっている", () => {
    // **移し忘れると、その手順はどこからも読まれない**——**入口には見出しだけが
    // 残るので、目で見ると移したように見える**
    const text = readFileSync(BODY, "utf8");

    expect(text, "ステップ 2 が無い").toContain("## 2. やることを決める");
    expect(text, "ステップ 3 が無い").toContain("## 3. レビュー指摘に対応する");
    expect(text, "ステップ 4 が無い").toContain("## 4. `ready` から 1 件を取って実装する");
    expect(text, "周回の出口が無い").toContain("### 周回の出口");
    expect(text, "ステップ 5 が無い").toContain("## 5. 空転を検出する");
  });

  it("ステップ 2 は入口に残っていない", () => {
    // **ステップ 2 は本体を読んだあとにしか走らない**ので、**入口に置く理由が無い**
    // ——**置いたままだと、cron が運ぶ本文は 500 行を超えたままである**（#319 の 2/2）
    const text = entry();

    expect(text, "ステップ 2 の本文が入口に残っている").not.toContain(
      "### 2.0 届いた指示を先に確認する",
    );
    expect(text, "ステップ 2.2 の本文が入口に残っている").not.toContain(
      "### 2.2 公開に失敗した周回を再開する",
    );
  });

  it("README が、入口と本体の置き場所を書いている", () => {
    // **運用する人が最初に読むのはここ**である（#319 の完了条件）。**分けた事実を
    // 書かないと、`.claude/commands/` だけを直した人が「本体が古いまま」に気づけない。**
    //
    // **貼り直しの案内もここに要る**——**入口を直した周回だけは、cron が運ぶ写しが
    // 古くなる**（**本体を直したぶんは次の周回が読む**）。
    const readme = readFileSync(join(REPO_ROOT, "loop/README.md"), "utf8");

    expect(readme, "本体の置き場所が書いていない").toContain("loop/procedure/");
    expect(readme, "読む口が書いていない").toContain("bin/loop-procedure-body");
    expect(readme, "貼り直しの案内が無い").toMatch(/\/loop.{0,20}貼り直す/);
  });

  it("入口が、運べる長さに収まっている", () => {
    // **これが #319 の目的そのものである。** **入口だけが cron に運ばれる**ので、
    // **入口が伸びるほど、手順書を直したときに走っているセッションが捨てる周回が増える。**
    //
    // **1 行も残せないわけではない**——**ステップ 1 は本体を読む前に走る**ので、
    // **入口から出せない**（lease を取る前に本体を読むと、**その周回が始まった時点の
    // 作業ツリーから読む**。ステップ 1.2）。**出せるものを出したあとの上限**である。
    //
    // **上限が無いと、少しずつ戻る。** **1 節ずつ書き足すぶんには誰も止めないので、
    // 元の 547 行へ静かに帰る**——**戻ったことに気づけるのは、この行だけ**である。
    // **両方の役に掛ける**（#319 の完了条件）——**master も移し終えた。**
    for (const role of ["worker", "master"] as const) {
      const lines = readFileSync(join(REPO_ROOT, `.claude/commands/loop-${role}.md`), "utf8").split(
        "\n",
      ).length;

      expect(
        lines,
        `${role} の入口が ${lines} 行ある。本体（loop/procedure/${role}.md）へ移すこと`,
      ).toBeLessThanOrEqual(200);
    }
  });
});

describe("本体を直しても、配られた本文は古くならない", () => {
  /** 入口と本体を写した**チェックアウトの写し**。**実物を触らない。** */
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

/**
 * **両方の役で、同じ 3 つを見る**（#329 のレビュー）。
 *
 * **試験が `procedureText()` で入口と本体を連結して読む**ので、**入口から本体へ
 * 実際に到達できるかは、そこでは分からない**——**呼び出しを消しても、同期の前へ
 * 動かしても、失敗したときに lease を返さなくても緑のまま**である。
 * **入口そのものを見る試験が要る。**
 */
describe.each([{ role: "worker" }, { role: "master" }] as const)(
  "$role の入口が、本体へ到達できる",
  ({ role }) => {
    function roleEntry(): string {
      return readFileSync(join(REPO_ROOT, `.claude/commands/loop-${role}.md`), "utf8");
    }

    /** 本体を読む節。**行き先が書かれるべきところ**である。 */
    function roleReadSection(): string {
      const text = roleEntry();
      const from = text.indexOf(`bin/loop-procedure-body ${role}`);
      expect(from, "本体を読む口が無い").toBeGreaterThanOrEqual(0);
      return text.slice(from).split("\n## ")[0] ?? "";
    }

    it("入口が、本体をディスクから読む口を持っている", () => {
      // **消しても、連結して読む試験は気づかない**
      expect(roleEntry(), "本体を読む口が入口に無い").toContain(`bin/loop-procedure-body ${role}`);
    });

    it("読むのは、同期のあとである", () => {
      // **前に置くと、その周回が始まった時点の作業ツリーから読む**（#323 の P1）
      const text = roleEntry();
      const sync = text.indexOf(`bin/loop-procedure-changed --role ${role}`);
      const read = text.indexOf(`bin/loop-procedure-body ${role}`);

      expect(sync, "同期の判定が入口に無い").toBeGreaterThanOrEqual(0);
      expect(read, "同期より先に本体を読んでいる").toBeGreaterThan(sync);
    });

    it("読めなかったら、押さえたぶんを返して終わると書いてある", () => {
      // **読むのは lease を取ったあと**なので、**返さずに終えると、
      // この作業場（役）は期限が切れるまで動けない**
      expect(roleReadSection(), "読めなかったときの行き先が書いていない").toContain(
        `bin/loop-lease release ${role}`,
      );
    });

    it("本体が、実際に読める", () => {
      // **文面だけを見ていると、置き場所を間違えても気づかない**——
      // **本物のスクリプトに出させる**
      // **砂場で起こす** (#390 のレビュー)。**記録（`valence-loop-lease-missing`）は
      // cwd の git から決まる**ので、**実物のリポジトリで起こすと、ふつうの
      // `./task check` が偽の「入口を飛ばした」を積む**——**保つ 20 件が入れ替わり、
      // 本物が残らない**（`AGENTS.md` §5。**観測をやめて、自分の砂場に身代わりを置く**）。
      // **読むのは実物の本体**である（スクリプトは自分の隣から辿る）。
      const sandbox = mkdtempSync(join(tmpdir(), "procedure-body-"));
      sandboxes.push(sandbox);
      expect(spawnSync("git", ["init", "--quiet", "-b", "main", sandbox]).status).toBe(0);
      const shown = spawnSync(join(REPO_ROOT, "bin/loop-procedure-body"), [role], {
        cwd: sandbox,
        encoding: "utf8",
      });

      expect(shown.status, shown.stderr).toBe(0);
      expect(shown.stdout.length, "本体が空である").toBeGreaterThan(0);
    });
  },
);
