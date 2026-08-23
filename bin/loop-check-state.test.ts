/**
 * **`./task check` が終わったかどうかを、記録として残す**（#375）。
 *
 * **2 つの作業場が、別々の日に同じ罠を踏んだ**——**「終わったこと」を読み違えた。**
 * **印（`check-exit=<合否>`）は終わったときにしか書かれない**（`task` の `cmd_check` は
 * `exec_app pnpm check` が返ってから `echo` する）——**足りないのは、読む側を
 * 強いるもの**である。
 *
 * **記録は作業場ごと**（`git rev-parse --git-dir`）。**共通ディレクトリではない**
 * ——**別の作業場の check は、こちらの commit の可否と関係が無い。**
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-check-state", import.meta.url));

describe("bin/loop-check-state", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "check-state-"));
    expect(spawnSync("git", ["init", "--quiet", repo]).status).toBe(0);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function run(args: string[]): { status: number; stdout: string; stderr: string } {
    const result = spawnSync(SCRIPT, args, { cwd: repo, encoding: "utf8" });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  /** 記録の置き場所。**作業場ごと**で、**走るたびに 1 つ**である (#130 と同じ形)。 */
  function statePath(): string {
    return join(repo, ".git", "valence-check-state.d");
  }

  it("記録が無ければ、4 を返す", () => {
    // **「無い」と「赤」を混ぜない**——**打っていない人を止める口ではない**
    expect(run(["--verdict"]).status).toBe(4);
  });

  it("走り始めたら、まだ終わっていないと答える", () => {
    expect(run(["running", "A"]).status).toBe(0);

    expect(run(["--verdict"]).status, "走っている最中を読めていない").toBe(3);
  });

  it("緑で終わったら、0 を返す", () => {
    run(["running", "A"]);
    expect(run(["finished", "A", "0"]).status).toBe(0);

    expect(run(["--verdict"]).status).toBe(0);
  });

  it("赤で終わったら、1 を返す", () => {
    run(["running", "A"]);
    run(["finished", "A", "1"]);

    expect(run(["--verdict"]).status).toBe(1);
  });

  it("殺された周回は、走っているままになる", () => {
    // **これが本体である。** **`done` を書けずに終わった check**——
    // **「終わっていない」と読めなければ、途中のログを緑と読む**
    run(["running", "A"]);

    expect(run(["--verdict"]).status, "殺された周回を「終わった」と読んでいる").toBe(3);
  });

  it("2 本走っていたら、片方が終わっても「走っている」", () => {
    // **これが本体である** (#376 のレビュー)。**記録が 1 つだと、後から終わったほうが
    // 上書きし**、**まだ走っている側が見えなくなる**——**2 本走るのは、この
    // リポジトリが既に前提にしている**（#130 が出力先を実行ごとに分けたのがそれ）。
    run(["running", "A"]);
    run(["running", "B"]);
    run(["finished", "B", "0"]);

    expect(run(["--verdict"]).status, "まだ走っている側が消えている").toBe(3);

    run(["finished", "A", "0"]);

    expect(run(["--verdict"]).status, "両方終わったのに緑にならない").toBe(0);
  });

  it("走り始めたら、前の合否は捨てる", () => {
    // **前の周回の緑で、いまの commit を通さない**——**木はもう変わっている**
    run(["running", "A"]);
    run(["finished", "A", "0"]);
    run(["running", "B"]);

    expect(run(["--verdict"]).status, "前の合否が残っている").toBe(3);
  });

  it("殺された周回の記録は、次の走りが片付ける", () => {
    // **これが無いと、出られない** (#184 の形)。**殺された周回は `finished` を
    // 書けない**ので記録は残る——**そのままだと、何度 check を走らせても
    // 「走っている」のまま**で、**commit が永久に止まる。**
    //
    // **id は `./task` の PID である**（`task` がそう渡す）——**生きていない PID の
    // 記録は、走り終えた周回のものではありえない。**
    run(["running", "999999"]); // **死んだ PID**（殺された周回の跡）
    run(["running", "A"]);
    run(["finished", "A", "0"]);

    expect(run(["--verdict"]).status, "殺された跡が残って、出られない").toBe(0);
  });

  it("生きている周回の記録は、片付けない", () => {
    // **緩めすぎない側**——**走っている相手を消すと、この Issue の穴が戻る**
    run(["running", `${process.pid}`]); // **いま生きている PID**
    run(["running", "A"]);
    run(["finished", "A", "0"]);

    expect(run(["--verdict"]).status, "走っている相手を消している").toBe(3);
  });

  it("知らない形は、読めない側へ倒す", () => {
    mkdirSync(statePath(), { recursive: true });
    writeFileSync(join(statePath(), "A"), "なにか\n");

    expect(run(["--verdict"]).status).toBe(2);
  });

  it("使い方の誤りは、通す側に倒さない", () => {
    expect(run([]).status).toBe(2);
    expect(run(["running"]).status, "id が要る").toBe(2);
    expect(run(["finished", "A"]).status).toBe(2);
    expect(run(["finished", "A", "合否"]).status).toBe(2);
    expect(run(["walking"]).status).toBe(2);
  });

  describe("所要時間を残す（#391）", () => {
    /** その走りの記録の行。 */
    function recordLines(id: string): string[] {
      return readFileSync(join(statePath(), id), "utf8").split("\n");
    }

    /** 積まれた所要時間の記録（`<始め>\t<終わり>\t<結果>`）。 */
    function durations(): string[][] {
      const listed = run(["--durations"]);
      expect(listed.status, listed.stderr).toBe(0);
      return listed.stdout
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.split("\t"));
    }

    function near(value: string | undefined): boolean {
      const epoch = Number(value);
      return Number.isInteger(epoch) && Math.abs(epoch - Math.floor(Date.now() / 1000)) <= 120;
    }

    it("走り始めた時刻が、記録に残る", () => {
      // **始めた時刻は、いままでどこにも残っていなかった**——**終わりは mtime に
      // 残るが、始めは `running` の上書きで消える**（**1 回の所要時間すら出せない**）
      run(["running", "A"]);

      expect(near(recordLines("A")[1]), "始めた時刻が残っていない").toBe(true);
    });

    it("走り終えた記録に、始めと終わりの両方が残る", () => {
      run(["running", "A"]);

      run(["finished", "A", "0"]);

      const lines = recordLines("A");
      expect(near(lines[1]), "始めた時刻を引き継いでいない").toBe(true);
      expect(near(lines[2]), "終わった時刻が残っていない").toBe(true);
    });

    it("古い読み手が読む 1 行目は、変えない", () => {
      // **`AGENTS.md` §5: 新しい書き手 → 古い読み手。** **前の版の `--verdict` は
      // `read -r kind value <記録` で 1 行目しか読まない**（`running` の片付けも同じ）
      // ——**行を足すのは安全だが、1 行目に列を足すと `finished 0 1700000000` が
      // 「合否を読めません」で止まる**（#281 と同じ形）。
      run(["running", "A"]);
      expect(recordLines("A")[0], "走っている記録の 1 行目が変わっている").toBe("running");

      run(["finished", "A", "0"]);

      expect(recordLines("A")[0], "終わった記録の 1 行目が変わっている").toBe("finished 0");
    });

    it("走りごとに、所要時間が積まれる", () => {
      // **走りの記録は次の走りが片付ける**（**そういう設計**）ので、**そこに残しても
      // 消える**——**あとから突き合わせるには、積む先が要る。**
      run(["running", "A"]);
      run(["finished", "A", "0"]);
      run(["running", "B"]);
      run(["finished", "B", "1"]);

      const rows = durations();
      expect(rows.length, "走りごとに積まれていない").toBe(2);
      expect(near(rows[0]?.[0]), "始めた時刻が積まれていない").toBe(true);
      expect(near(rows[0]?.[1]), "終わった時刻が積まれていない").toBe(true);
      expect(
        rows.map((row) => row[2]),
        "合否が積まれていない",
      ).toEqual(["0", "1"]);
    });

    it("殺された走りも、殺されたと分かる形で積む", () => {
      // **実害はこちら側で出ている**（**道具の 10 分制限で 3 回切られた**）——
      // **切られた走りが記録に残らないと、「切られやすさ」を測れない。**
      mkdirSync(statePath(), { recursive: true });
      writeFileSync(
        join(statePath(), "999999"), // **死んだ PID**（殺された走りの跡）
        `running\n${Math.floor(Date.now() / 1000) - 600}\n`,
      );

      run(["running", "A"]); // 次の走りが片付ける

      const rows = durations();
      expect(rows.length, "殺された走りが積まれていない").toBe(1);
      expect(rows[0]?.[2], "殺されたことが読み取れない").toBe("killed");
    });

    it("記録が伸び続けない", () => {
      // **直近の分だけを残す**（`bin/loop-lease` の周回の長さと同じ形）
      for (let index = 0; index < 12; index += 1) {
        run(["running", `run${index}`]);
        run(["finished", `run${index}`, "0"]);
      }

      expect(durations().length, "走りのたびに伸びている").toBeLessThanOrEqual(10);
    });

    describe("前の版が書いた記録を、いまの版が読む", () => {
      // **書式は両方向に壊れる**（`AGENTS.md` §5）。**新しい書き手 → 古い読み手**は
      // 上の「1 行目は変えない」で押さえたが、**古い入力 → 新しい読み手**（#200 の向き）
      // **が残っていた**——**マージした瞬間、どの作業場の `.git` にも
      // 「前の版が書いた記録」しか無い。**
      //
      // **入力は書式そのもの**である（**前の版を持ってこなくても、`running\n` と
      // `finished 0\n` を置けば同じ**）。

      /** 前の版が書いた記録（**時刻の行が無い**）。 */
      function oldRecord(id: string, body: string): void {
        mkdirSync(statePath(), { recursive: true });
        writeFileSync(join(statePath(), id), body);
      }

      it("走っている記録を、これまでどおり読む", () => {
        oldRecord("A", "running\n");

        expect(run(["--verdict"]).status, "前の版の記録で止まっている").toBe(3);
      });

      it("終わった記録の合否を、これまでどおり読む", () => {
        oldRecord("A", "finished 0\n");
        expect(run(["--verdict"]).status, "前の版の緑を読めていない").toBe(0);

        oldRecord("A", "finished 1\n");

        expect(run(["--verdict"]).status, "前の版の赤を読めていない").toBe(1);
      });

      it("前の版の記録から、終わりへ進める", () => {
        // **走っている最中に版が入れ替わる**——**`running` を書いたのは前の版、
        // `finished` を書くのはいまの版**である。**始めた時刻は残っていない**ので、
        // **積まない**（**いまの時刻で埋めると、所要時間が 0 秒に化ける**）。
        oldRecord("A", "running\n");

        expect(run(["finished", "A", "0"]).status, "終われなくなっている").toBe(0);

        expect(run(["--verdict"]).status, "合否を残せていない").toBe(0);
        expect(recordLines("A")[0], "1 行目が変わっている").toBe("finished 0");
        expect(run(["--durations"]).status, "始めた時刻の無い走りを積んでいる").toBe(4);
      });

      it("前の版が残した、殺された記録を片付けられる", () => {
        // **ここで止まると出られない**（#184 の形）——**片付かない記録があると、
        // 何度走らせても「走っている」のまま**で、**commit が永久に止まる。**
        oldRecord("999999", "running\n"); // **死んだ PID**（前の版が残した跡）

        run(["running", "A"]);
        run(["finished", "A", "0"]);

        expect(run(["--verdict"]).status, "前の版の跡で、出られなくなっている").toBe(0);
        expect(
          durations().map((row) => row[2]),
          "始めた時刻の無い走りを、殺されたぶんとして積んでいる",
        ).toEqual(["0"]);
      });
    });

    it("積む先が無ければ、記録が無いと答える", () => {
      // **「無い」と「読めない」を混ぜない**（`--verdict` と同じ語彙）
      expect(run(["--durations"]).status).toBe(4);
    });
  });

  it("記録は作業場ごとに置く", () => {
    // **共通ディレクトリに置くと、別の作業場の check がこちらの可否を決める**
    run(["running", "A"]);

    expect(existsSync(join(statePath(), "A")), "作業場の外に置いている").toBe(true);
    expect(readFileSync(join(statePath(), "A"), "utf8"), "何が起きたかが読めない").toContain(
      "running",
    );
  });
});
