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

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { holdLock, sleepSync, waitUntil } from "../test/held-lock";
import { budgetFor } from "../test/slow-machine";

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

  function run(
    args: string[],
    env: NodeJS.ProcessEnv = process.env,
  ): { status: number; stdout: string; stderr: string } {
    const result = spawnSync(SCRIPT, args, { cwd: repo, encoding: "utf8", env });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  /** 記録の置き場所。**作業場ごと**で、**走るたびに 1 つ**である (#130 と同じ形)。 */
  function statePath(): string {
    return join(repo, ".git", "valence-check-state.d");
  }

  /**
   * **切られた走りを、打ち直さずに拾う**（#552）。
   *
   * **単独の `./task check` が外側の 10 分に届くようになった**（**実測 670 / 698 秒**）。
   * **切られると、コンテナの中は走り続ける**（#528）——**そこで打ち直すと、
   * 同じものを 2 度走らせる**（**1 周ぶん余計**）。
   *
   * **速くするのではなく、切られた結果を変える。** **走っているものに付き直せば、
   * 待つだけで済む**——**待つ側が切られても、もう一度打てばよい**（**そのぶんは捨てても
   * 何も失われない**）。
   */
  describe("走っている check の合否を待つ", () => {
    /** **待つ間隔は試験で短くできる**（`LOCK_WAIT_SEC` と同じ形）。 */
    const FAST = { ...process.env, LOOP_CHECK_STATE_AWAIT_SEC: "0" };

    it("終わっていれば、そのまま合否を返す", () => {
      run(["running", "A"]);
      run(["finished", "A", "0"]);

      expect(run(["--await"], FAST).status).toBe(0);
    });

    it("赤で終わっていれば、赤を返す", () => {
      run(["running", "A"]);
      run(["finished", "A", "1"]);

      expect(run(["--await"], FAST).status).toBe(1);
    });

    it("走っているあいだは待ち、終わったら合否を返す", async () => {
      // **これが本題である。** **待たずに 3 を返すだけなら、打ち直すのと変わらない。**
      run(["running", "A"]);
      const waiting = spawn(SCRIPT, ["--await"], { cwd: repo, env: FAST });
      const finished = new Promise<number>((resolve) => {
        waiting.on("close", (code) => resolve(code ?? -1));
      });

      await waitUntil(() => true, 50);
      run(["finished", "A", "0"]);

      expect(await finished, "終わったのに待ち続けている").toBe(0);
    });

    it("走っている check が無ければ、無いと言う", () => {
      // **「打っていない」を「緑」に化けさせない**（`--verdict` と同じ語彙）
      expect(run(["--await"], FAST).status).toBe(4);
    });

    it("待つ間隔の設定が壊れていたら、そう言う", () => {
      // **隣の設定と同じ形**（**壊れた設定で黙って回り続けない**）
      const broken = run(["--await"], { ...process.env, LOOP_CHECK_STATE_AWAIT_SEC: "abc" });

      expect(broken.status).toBe(2);
      expect(broken.stderr).toContain("LOOP_CHECK_STATE_AWAIT_SEC");
    });
  });

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
    /** 起こした側を、グループごと落とす。**試験がどう終わっても残さない**（#153）。 */
    function killAll(racers: ReturnType<typeof spawn>[]): void {
      for (const racer of racers) {
        if (racer.pid === undefined) {
          continue;
        }
        try {
          process.kill(-racer.pid, "SIGKILL");
        } catch {
          // もう居ない
        }
      }
    }

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

    it(
      "2 本が同じ死んだ記録を見ても、1 回しか積まない",
      () => {
        // **`flock` が守っていたのは追記だけ** (#392 のレビュー)。**「死んでいると
        // 判った」から「消した」までの間に、もう 1 本が同じ記録を見る**——**両方が
        // `killed` を積む。** **水増しされるのは「切られやすさ」**で、
        // **それはこの PR が測るために作った数**である（**測る道具が、測りたいものを
        // 膨らませる**）。**同じ隙間を `record_missing` で踏んで直してある。**
        //
        // **踏む形を入力に置く。** **追記の口を握らせておく**と、**取り損ねた側は
        // 記録がまだ在るうちに読む**——**直す前は、必ず 2 行積まれる。**
        mkdirSync(statePath(), { recursive: true });
        writeFileSync(
          join(statePath(), "999999"), // **死んだ PID**（殺された走りの跡）
          `running\n${Math.floor(Date.now() / 1000) - 600}\n`,
        );
        const held = holdLock({
          dir: repo,
          lock: join(repo, ".git", "valence-check-runs.lock"),
        });
        const racers = ["A", "B"].map((id) =>
          spawn(SCRIPT, ["running", id], { cwd: repo, detached: true, stdio: "ignore" }),
        );
        try {
          // **2 本とも、追記の口の前まで進ませる**（**この機械は 1 回の起動に最大 1 秒**）
          sleepSync(3_000);
        } finally {
          held.release();
        }
        // **書き上がりで待つ**（**イベントループを止めて待つので、`exit` は拾えない**）
        const finished = waitUntil(
          () => ["A", "B"].every((id) => existsSync(join(statePath(), id))),
          30_000,
        );
        killAll(racers);
        expect(finished, "2 本とも書き終えていない（この試験は成立していない）").toBe(true);

        expect(
          durations().filter((row) => row[2] === "killed").length,
          "同じ走りを 2 回積んでいる",
        ).toBe(1);
      },
      budgetFor(6),
    );

    it(
      "片付けの口を取り損ねても、片付けは進む",
      () => {
        // **ここで止まると出られない** (#184)。**握れないからと片付けを飛ばすと、
        // 殺された記録が残ったまま**——**何度走らせても「走っている」のままで、
        // commit が永久に止まる。** **落とすのは測るほうだけ**である
        // （**握っている側が積む**ので、**二重に数える側へは倒さない**）。
        mkdirSync(statePath(), { recursive: true });
        writeFileSync(
          join(statePath(), "999999"),
          `running\n${Math.floor(Date.now() / 1000) - 600}\n`,
        );
        const held = holdLock({
          dir: repo,
          lock: join(repo, ".git", "valence-check-state.d.lock"),
        });

        try {
          const started = run(["running", "A"], {
            ...process.env,
            LOOP_CHECK_STATE_LOCK_WAIT_SEC: "1",
          });

          expect(started.status, started.stderr).toBe(0);
        } finally {
          held.release();
        }

        expect(
          existsSync(join(statePath(), "999999")),
          "殺された記録が残っている（出られなくなる）",
        ).toBe(false);
        expect(run(["--durations"]).status, "取り損ねた側が積んでいる").toBe(4);
      },
      budgetFor(4),
    );

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

    describe("2 本が重なったことを、記録から読む", () => {
      // **`./task check` が 2 本並走すると、負荷で時間切れになる**（#509）。
      // **今日 2 件測れた**が、**どちらも人の報告でしか残っていない**——
      // **重なったことが記録に無ければ、頻度も、直したあとの効きも測れない。**
      //
      // **所要時間は作業場ごとに積んでいた**ので、**別々のファイルに分かれていた**
      // ——**同じ機械で走っているのに、突き合わせる先が無い。**

      /** 積む先。**共有の `.git`**（**作業場をまたいで 1 つ**）。 */
      function runsPath(): string {
        return join(repo, ".git", "valence-check-runs");
      }

      /** この作業場の名前（`git rev-parse --show-toplevel`）。 */
      function here(): string {
        return realpathSync(repo);
      }

      /** 別の作業場が積んだ行を置く。**`<作業場>\t<始め>\t<終わり>\t<結果>`** */
      function seed(rows: readonly (readonly string[])[]): void {
        writeFileSync(runsPath(), `${rows.map((row) => row.join("\t")).join("\n")}\n`);
      }

      function overlaps(): { status: number; stdout: string; stderr: string } {
        return run(["--overlaps"]);
      }

      it("積んだ行に、どの作業場のものかが残る", () => {
        // **名前が無いと、突き合わせられない**——**行が混ざるだけ**である
        run(["running", "A"]);
        run(["finished", "A", "0"]);

        const rows = readFileSync(runsPath(), "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => line.split("\t"));

        expect(rows.length, "共有の記録に積まれていない").toBe(1);
        expect(rows[0]?.[0], "どの作業場のものか分からない").toBe(here());
      });

      it("`--durations` は、この作業場のぶんだけを、これまでどおり出す", () => {
        // **読み手の意味を変えない**（`AGENTS.md` §5）——**所要時間は
        // 「この作業場の速さ」**で、**他所のぶんを混ぜると、振れ幅が別のものになる。**
        const started = Math.floor(Date.now() / 1000) - 600;
        seed([["/somewhere/else", `${started}`, `${started + 300}`, "0"]]);
        run(["running", "A"]);
        run(["finished", "A", "0"]);

        const rows = durations();

        expect(rows.length, "他の作業場のぶんを混ぜている").toBe(1);
        expect(rows[0]?.length, "列が増えている（読み手の書式が変わっている）").toBe(3);
      });

      it("別の作業場と重なっていたら、その組を出す", () => {
        // **完了条件の 1 つ目**（#509）——**人の報告に頼らずに、あとから分かること**
        const now = Math.floor(Date.now() / 1000);
        seed([
          [here(), `${now - 900}`, `${now - 300}`, "0"],
          ["/somewhere/else", `${now - 600}`, `${now - 60}`, "0"],
        ]);

        const found = overlaps();

        expect(found.status, found.stderr).toBe(0);
        expect(found.stdout, "こちらの作業場が出ていない").toContain(here());
        expect(found.stdout, "相手の作業場が出ていない").toContain("/somewhere/else");
      });

      it("重なっていなければ、無いと言う", () => {
        // **「無い」と「読めない」を混ぜない**——**0 件は、この口の正常な答え**である
        const now = Math.floor(Date.now() / 1000);
        seed([
          [here(), `${now - 900}`, `${now - 600}`, "0"],
          ["/somewhere/else", `${now - 300}`, `${now - 60}`, "0"],
        ]);

        const found = overlaps();

        expect(found.status, "重なっていないのに、あると言っている").toBe(1);
        expect(found.stdout, "何か出している").toBe("");
      });

      it("同じ作業場どうしは、重なりに数えない", () => {
        // **見たいのは「同じ機械で 2 つの作業場が走った」ほう**である
        // ——**1 つの作業場の中で区間が重なるのは、片付けの跡**（**次の走りが
        // 片付けるまで、切られた走りの終わりは書かれない**）。
        //
        // **どちらも終わった走りにする**——**切られた走りは別の規則で外れる**ので、
        // **それだと、この規則を消しても赤くならない**（**変異で判った**）。
        const now = Math.floor(Date.now() / 1000);
        seed([
          [here(), `${now - 900}`, `${now - 300}`, "0"],
          [here(), `${now - 600}`, `${now - 60}`, "1"],
        ]);

        expect(overlaps().status, "同じ作業場の 2 本を、並走として数えている").toBe(1);
      });

      it("切られた走りは、区間として数えない", () => {
        // **終わりは片付けた時刻**である（**次の走りが片付けるまで書かれない**）
        // ——**そのまま区間として読むと、次の走りまでの何十分かが
        // 「重なっていた」に化ける。** **切られたことは `--durations` に残る。**
        const now = Math.floor(Date.now() / 1000);
        seed([
          [here(), `${now - 3600}`, `${now - 60}`, "killed"],
          ["/somewhere/else", `${now - 900}`, `${now - 300}`, "0"],
        ]);

        expect(overlaps().status, "片付けの時刻を、走っていた時間として読んでいる").toBe(1);
      });

      it(
        "積めなくても、合否は残り、この check は止まらない",
        () => {
          // **「積めなくても、合否は残っている」と書いてある道**（#391）——
          // **そこを通る試験が無かった。** **通らない行は、`set -u` で落ちても
          // 緑のまま**である（**名前を変えたときに、まさにそこが残った**。#511 のレビュー）。
          //
          // **積む口を握らせて通す**（`bin/loop-lease` と同じ形の待ち時間の設定）。
          run(["running", "A"]);
          const held = holdLock({ dir: repo, lock: `${runsPath()}.lock` });
          let finished: { status: number; stdout: string; stderr: string };
          try {
            finished = run(["finished", "A", "0"], {
              ...process.env,
              LOOP_CHECK_STATE_LOCK_WAIT_SEC: "1",
            });
          } finally {
            held.release();
          }

          expect(finished.status, finished.stderr).toBe(0);
          expect(finished.stderr, "積めなかったことを黙っている").toContain("積めません");
          expect(run(["--verdict"]).status, "合否が残っていない").toBe(0);
        },
        budgetFor(4),
      );

      it(
        "殺された走りを積めなくても、片付けは進む",
        () => {
          // **同じ道の、もう 1 つの口**（**片付けながら積む側**）——**こちらも
          // 通らない行だった。** **片付けが止まると出られない** (#184)。
          mkdirSync(statePath(), { recursive: true });
          writeFileSync(
            join(statePath(), "999999"), // **死んだ PID**（殺された走りの跡）
            `running\n${Math.floor(Date.now() / 1000) - 600}\n`,
          );
          const held = holdLock({ dir: repo, lock: `${runsPath()}.lock` });
          let started: { status: number; stdout: string; stderr: string };
          try {
            started = run(["running", "A"], {
              ...process.env,
              LOOP_CHECK_STATE_LOCK_WAIT_SEC: "1",
            });
          } finally {
            held.release();
          }

          expect(started.status, started.stderr).toBe(0);
          expect(started.stderr, "積めなかったことを黙っている").toContain("積めません");
          expect(
            existsSync(join(statePath(), "999999")),
            "殺された記録が残っている（出られなくなる）",
          ).toBe(false);
        },
        budgetFor(4),
      );

      it("記録が無ければ、記録が無いと答える", () => {
        expect(overlaps().status).toBe(4);
      });

      it("刈り込みは、作業場ごとに数える", () => {
        // **共有にしたので、他所の走りでこちらの履歴が押し出されうる**
        // ——**振れ幅を見るための直近が、隣の作業場の忙しさで消える。**
        const now = Math.floor(Date.now() / 1000);
        seed(
          Array.from({ length: 12 }, (_, index) => [
            "/somewhere/else",
            `${now - 3600 + index * 60}`,
            `${now - 3300 + index * 60}`,
            "0",
          ]),
        );

        run(["running", "A"]);
        run(["finished", "A", "0"]);

        expect(durations().length, "こちらのぶんが押し出されている").toBe(1);
        // **他所のぶんも落とさない**（**同じ形の裏側**）——**こちらが積むたびに
        // 隣の履歴が消えると、隣から見て「押し出された」になる。**
        const rows = readFileSync(runsPath(), "utf8")
          .split("\n")
          .filter((line) => line !== "");
        expect(
          rows.filter((line) => line.startsWith("/somewhere/else")).length,
          "他の作業場のぶんを落としている",
        ).toBe(12);
      });
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
