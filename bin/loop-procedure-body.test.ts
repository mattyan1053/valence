import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-procedure-body", import.meta.url));

/**
 * **cron は、登録した時点の本文を再生する**（#319）。**ディスクの手順書を毎回
 * 読み直すわけではない**ので、**手順書を直すたびに、走っているセッションの本文が古くなる。**
 *
 * **検出は正しく働いている**（#241 / #243）——**そのぶん周回が捨てられる。**
 * **実測で 1 日 5 回**。**ループが自分の手順書を直すほど、自分の周回が捨てられる。**
 *
 * **本体を、cron が運ぶ本文から外す。** **入口だけを運ばせ、本体は毎周回ディスクから読む。**
 *
 * **読めなかったら止まる。** **黙って古い手順で走るのがいちばん危ない**——
 * **入口には本体が無いので、「読めないまま進む」は「手順の大半を飛ばす」ことになる。**
 */
describe("bin/loop-procedure-body", () => {
  const sandboxes: string[] = [];

  afterEach(() => {
    for (const dir of sandboxes.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function run(args: string[], script: string = SCRIPT): { status: number; stdout: string } {
    const result = spawnSync(script, args, { encoding: "utf8" });
    return { status: result.status ?? -1, stdout: result.stdout };
  }

  /**
   * 本体を差し替えた**チェックアウトの写し**を作る。**実物を触らない。**
   *
   * **スクリプトの隣から本体を辿る**ので、**cwd を変えるだけでは足りない**
   * ——**スクリプトごと写す**（`bin/loop-procedure-stamp` と同じ置き方）。
   */
  function checkoutWith(body: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), "procedure-body-"));
    sandboxes.push(dir);
    mkdirSync(join(dir, "bin"), { recursive: true });
    mkdirSync(join(dir, "loop", "procedure"), { recursive: true });
    copyFileSync(SCRIPT, join(dir, "bin", "loop-procedure-body"));
    chmodSync(join(dir, "bin", "loop-procedure-body"), 0o755);
    if (body !== null) {
      writeFileSync(join(dir, "loop", "procedure", "worker.md"), body);
    }
    return join(dir, "bin", "loop-procedure-body");
  }

  it("本体をそのまま出す", () => {
    const script = checkoutWith("# 本体\n\nここに手順がある。\n");

    const result = run(["worker"], script);

    expect(result.status, "本体を出せていない").toBe(0);
    expect(result.stdout).toBe("# 本体\n\nここに手順がある。\n");
  });

  it("実物の本体を出せる", () => {
    // **置き場所が合っているか**を実物で見る（写しだけを見ていると、
    // **本体を置き忘れても緑になる**）。**master は次の PR で移す**
    const result = run(["worker"]);

    expect(result.status, "本体を出せていない").toBe(0);
    expect(result.stdout.length, "本体が空である").toBeGreaterThan(0);
  });

  /**
   * **入口もディスクから読めるようにする**（#373）。
   *
   * **配られた本文が古いとき、呼び直しで新しい版が届く保証は無い**
   * （**実測で 2 回中 1 回**。#94）——**届かなければ、人が来るまで動けない。**
   * **読む先がディスクにあれば、その周回のうちに前へ進める。**
   *
   * **印の検査は捨てない** (#241 / #243 / #244)——**読み直した本文の印で
   * `acquire` を打ち直す**ので、**「古い手順で走り続ける」形にはならない。**
   */
  describe("入口を読む", () => {
    /** 入口を差し替えた**チェックアウトの写し**を作る。**実物を触らない。** */
    function checkoutWithEntry(entry: string | null): string {
      const dir = mkdtempSync(join(tmpdir(), "procedure-entry-"));
      sandboxes.push(dir);
      mkdirSync(join(dir, "bin"), { recursive: true });
      mkdirSync(join(dir, ".claude", "commands"), { recursive: true });
      copyFileSync(SCRIPT, join(dir, "bin", "loop-procedure-body"));
      chmodSync(join(dir, "bin", "loop-procedure-body"), 0o755);
      if (entry !== null) {
        writeFileSync(join(dir, ".claude", "commands", "loop-worker.md"), entry);
      }
      return join(dir, "bin", "loop-procedure-body");
    }

    it("入口をそのまま出す", () => {
      // **印の行も出す**——**読んだ側は、その印で `acquire` を打ち直す**
      const script = checkoutWithEntry("<!-- 版: abc123 -->\n\n# 入口\n");

      const result = run(["--entry", "worker"], script);

      expect(result.status, "入口を出せていない").toBe(0);
      expect(result.stdout, "印の行が落ちている").toContain("<!-- 版: abc123 -->");
      expect(result.stdout).toContain("# 入口");
    });

    it("実物の入口を出せる", () => {
      // **写しではなく、この checkout のものを読めること**
      const result = run(["--entry", "worker"]);

      expect(result.status).toBe(0);
      expect(result.stdout, "実物の入口が出ていない").toContain("bin/loop-lease acquire worker");
    });

    it("入口が無ければ、止まる側へ倒れる", () => {
      // **読めないまま進むのは「手順を飛ばす」と同じ**である（本体と同じ判断）
      const script = checkoutWithEntry(null);

      expect(run(["--entry", "worker"], script).status).toBe(2);
    });

    it("役を渡さなければ、止まる側へ倒れる", () => {
      expect(run(["--entry"]).status).toBe(2);
      expect(run(["--entry", "workers"]).status).toBe(2);
    });

    it("本体は、これまでどおり出る", () => {
      // **口を足しても、既存の呼び出しは変わらない**（退行の検出）
      expect(run(["worker"]).status).toBe(0);
    });
  });

  it("本体が無ければ、止まる側へ倒れる", () => {
    // **完了条件。** **読めない周回が、黙って古い手順で走らないこと**
    const script = checkoutWith(null);

    expect(run(["worker"], script).status).toBe(2);
  });

  it("使い方の誤りも、止まる側へ倒れる", () => {
    expect(run([]).status).toBe(2);
    expect(run(["それ以外の役"]).status).toBe(2);
    expect(run(["worker", "余計な引数"]).status).toBe(2);
  });
});
