/**
 * **始まらなかった周回が、どこにも残らない**（#378）。
 *
 * **#367 が数えられるようにしたのは「捨てた周回」**である。**始まってすらいない周回は
 * その手前**にあり、**`bin/loop-lease` の印は「周回が始まったとき」に付く**ので、
 * **始まらなければ何も書かれない。**
 *
 * **実測**（2026-08-22、worker-1）: **要求を出してから 2.5 時間、その作業場は動かず、
 * カウンタは 2 つとも 0 だった。** **`bin/loop-stall` は「周回を始めたばかり」と答える**
 * ——**人に突かれて始まった周回も、cron の周回も、同じ印**だったからである。
 *
 * **だから、始まった周回に「どう始まったか」を書く。** **人に突かれたぶんを cron と
 * 数えると、今回と同じ「健全に見える」に戻る。**
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

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 周回を始められる作業場。**実物のスクリプトを置く**（#227）。 */
function workspace(): { dir: string; stamp: string } {
  const dir = mkdtempSync(join(tmpdir(), "loop-cadence-"));
  sandboxes.push(dir);
  expect(spawnSync("git", ["init", "--quiet", "-b", "main", dir]).status).toBe(0);
  mkdirSync(join(dir, "bin"), { recursive: true });
  for (const name of ["loop-lease", "loop-procedure-stamp", "loop-cadence", "loop-stall"]) {
    const target = join(dir, "bin", name);
    copyFileSync(join(REPO_ROOT, "bin", name), target);
    chmodSync(target, 0o755);
  }
  mkdirSync(join(dir, ".claude", "commands"), { recursive: true });
  writeFileSync(
    join(dir, ".claude", "commands", "loop-worker.md"),
    "<!-- 版: 000000000000 -->\n手順書\n",
  );
  // **どこに作業場が居るかを答える口**（本物は `./task loop:worker:paths`）。
  // **既定はこの作業場 1 つ**——**居るはずのものから並べる**ので、置かないと何も見えない。
  // **本物は下位コマンドで答えを変える**——**`loop:master:path` は、master の作業場が
  // 登録されていなければ exit 1**（`./task`）。**既定は「master は居ない」。**
  taskAnswers(dir, { workerPaths: [dir] });
  const stamped = spawnSync(join(dir, "bin/loop-procedure-stamp"), ["worker"], {
    cwd: dir,
    encoding: "utf8",
  });
  expect(stamped.status, stamped.stderr).toBe(0);
  return { dir, stamp: stamped.stdout.trim() };
}

/**
 * **どこに作業場が居るかを答える口**（本物は `./task`）。
 *
 * **`loop:worker:paths` は worker のぶんだけ**を並べ、**`loop:master:path` は master の
 * 作業場**を出す（**登録されていなければ exit 1**）——**master を除いているのは
 * あちら**なので、**この試験でも 2 つの口に分けて答える。**
 */
function taskAnswers(dir: string, answers: { workerPaths?: string[]; masterPath?: string }): void {
  const workers = (answers.workerPaths ?? []).map((path) => JSON.stringify(path)).join(" ");
  const master =
    answers.masterPath === undefined
      ? "exit 1"
      : `printf '%s\\n' ${JSON.stringify(answers.masterPath)}`;
  writeFileSync(
    join(dir, "task"),
    `#!/usr/bin/env bash\ncase "$1" in\n  loop:worker:paths) printf '%s\\n' ${workers} ;;\n  loop:master:path) ${master} ;;\nesac\n`,
    { mode: 0o755 },
  );
}

/** 1 周ぶん（取って、返す）。**どう始まったかを渡す。** */
function round(dir: string, stamp: string, trigger?: string): void {
  const args = [
    "acquire",
    "worker",
    stamp,
    ...(trigger === undefined ? [] : ["--trigger", trigger]),
  ];
  const taken = spawnSync(join(dir, "bin/loop-lease"), args, { cwd: dir, encoding: "utf8" });
  expect(taken.status, taken.stderr).toBe(0);
  const token = taken.stdout.trim();
  const back = spawnSync(join(dir, "bin/loop-lease"), ["release", "worker", token], {
    cwd: dir,
    encoding: "utf8",
  });
  expect(back.status, back.stderr).toBe(0);
}

/**
 * **時刻を決めた記録を置く。**
 *
 * **置き場所と書式は `bin/loop-lease` が決める**ので、**上の `round()` が実際に
 * 書いたものを、この試験の `cadence()` が読めること**（`実際に始めた周回が読める`）で
 * 両端を留めてある——**ここだけが緑になる形にはならない。**
 */
function records(dir: string, lines: [number, string][], workspace = dir, role = "worker"): void {
  const scope = spawnSync(join(dir, "bin/loop-lease"), ["scope", role], {
    cwd: dir,
    encoding: "utf8",
  });
  expect(scope.status, scope.stderr).toBe(0);
  writeFileSync(
    join(dir, ".git", `valence-loop-starts-${scope.stdout.trim()}`),
    `${lines.map(([at, trigger]) => `${at}\t${trigger}\t${workspace}`).join("\n")}\n`,
  );
}

function cadence(dir: string, env: Record<string, string> = {}) {
  return spawnSync(join(dir, "bin/loop-cadence"), [], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("周回が始まったことを、どう始まったかごと残す", () => {
  it("cron の周回と、人に突かれた周回を見分ける", () => {
    // **これが無いと、今回と同じ「始めたばかり」に化ける**（#378）
    const { dir } = workspace();
    records(dir, [
      [1_000, "cron"],
      [2_000, "poke"],
    ]);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "2100", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.stdout, "cron の周回が読めない").toMatch(/last_cron=1000/);
    expect(done.stdout, "突かれた周回が読めない").toMatch(/last_poke=2000/);
  });

  it("突かれた周回だけが続いても、cron は止まったままだと言う", () => {
    // **これが実測の形である**——**人が突けば周回は回るので、外からは健全に見える**
    const { dir } = workspace();
    records(dir, [
      [1_000, "cron"],
      [9_000, "poke"],
      [9_500, "poke"],
    ]);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.status, "動いているように見えている").toBe(1);
    expect(done.stdout, "止まっていると言っていない").toMatch(/stale/);
  });

  it("止まっていると言うときは、次にどこを見るかも言う", () => {
    // **判定を持つところに、次の一手を置く** (#430)。**2026-08-24、3 つの役すべてが
    // `stale` になり、3 つのセッションが別々に同じところを探した**——**原因は
    // 予定表が空だったこと**（**recurring は 7 日で期限切れになる**）。
    //
    // **master は「cron が 1 度も来ていない」と読み違えて、人へ渡しかけている。**
    const { dir } = workspace();
    records(dir, [
      [1_000, "cron"],
      [9_500, "poke"],
    ]);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.status, "止まっていると言っていない").toBe(1);
    expect(done.stderr, "まず予定表を引く、が無い").toMatch(/CronList/);
    // **限界も同じところに**——**言えるのは「記録に無い」まで**である
    expect(done.stderr, "この記録から言えることの限界が無い").toMatch(/直近/);
    expect(done.stderr, "走っている最中の cron が記録に残らないことが無い").toMatch(/acquire/);
  });

  it("別の役だけが止まっていても、その役の予定表へ案内する", () => {
    // **案内が指す先が、証拠の出どころより広かった** (#431 のレビュー)。
    // **`./task loop:status` は全部の役を見る**ので、**worker から呼んで master だけが
    // `stale` のとき**、**読んだ人は自分の予定表を引き、そこは正常なので「何ともない」で
    // 終わる**——**空だったのは master 側**である。
    //
    // **2026-08-24 の実測がまさにその形**だった（**3 つとも stale だったので隠れていた**）。
    //
    // **入力に踏む形を置く**——**呼んだ役は健全・別の役が `stale`。**
    const { dir } = workspace();
    records(dir, [
      [8_000, "cron"],
      [9_800, "cron"],
    ]);
    taskAnswers(dir, { workerPaths: [dir], masterPath: dir });
    records(
      dir,
      [
        [1_000, "cron"],
        [9_500, "poke"],
      ],
      dir,
      "master",
    );

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.status, `${done.stdout}\n${done.stderr}`).toBe(1);
    expect(done.stdout, "master が止まっていると言っていない").toMatch(/scope=master.*stale/);
    // **呼んだ側の予定表を指さない**（**そこは正常なので、そこで止まる**）
    expect(done.stderr, "呼んだ役の予定表を指している").not.toMatch(/このセッション/);
    expect(done.stderr, "止まっている役のセッションを指していない").toMatch(/stale と出た役/);
  });

  it("止まっている行から、どの作業場かが分かる", () => {
    // **worker は 2 人いる** (#433)。**役名は 2 つとも `worker`** で、**出るのは
    // `worker-f3f2c` のような digest だけ**——**読んだ人は、セッションを順に当たる**
    // ことになる（**#430 が消したかったのは、まさにその探索**）。
    //
    // **digest から手で戻すことはできる**（`./task loop:worker:paths` を回して同じ
    // 計算をする）が、**できることと、その場で分かることは違う。**
    const { dir } = workspace();
    records(dir, [
      [1_000, "cron"],
      [9_500, "poke"],
    ]);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.status, "止まっていると言っていない").toBe(1);
    expect(done.stdout, "どの作業場かが出ていない").toContain(`workspace=${dir}`);
  });

  it("止まっていない行には、作業場を出さない", () => {
    // **毎回全部の道を出さない** (#433 の条件)——**読むのは止まっている行だけ**である
    const { dir } = workspace();
    records(dir, [
      [8_000, "cron"],
      [9_800, "cron"],
    ]);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.status, `${done.stdout}\n${done.stderr}`).toBe(0);
    expect(done.stdout, "止まっていない行にも道を出している").not.toContain("workspace=");
  });

  it("1 度も始まっていない作業場でも、どこかが分かる", () => {
    // **`never` も止まっている側**である（**足したばかりの worker がここへ来る**）
    // ——**そこが「どの作業場か」を、いちばん知りたい。**
    const { dir } = workspace();

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.status, "始まっていないと言っていない").toBe(1);
    expect(done.stdout, "never の行に道が無い").toContain(`workspace=${dir}`);
  });

  it("作業場を引けなかったときは、引けないと言う", () => {
    // **いちばん要るところで出ない** (#435 のレビュー)。**`./task loop:master:path` が
    // 答えない＝worktree が消えた・動いた**という状況で、**まさに「どこにあるのか」を
    // 知りたい場面**である——**そこで行が出ないと、案内が無い行を探させる。**
    //
    // **「読めなかった」を「無かった」に化けさせない**（`bin/doctor` と同じ形）。
    const { dir } = workspace();
    records(dir, [[9_900, "cron"]]);
    // **記録は在るのに、場所を答えない**（**`taskAnswers` は master を出さない**）
    records(
      dir,
      [
        [1_000, "cron"],
        [9_500, "poke"],
      ],
      dir,
      "master",
    );

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.status, "master が止まっていると言っていない").toBe(1);
    expect(done.stdout, "master の行に道が無い").toMatch(/scope=master[\s\S]*workspace=/);
    expect(done.stdout, "引けなかったことを言っていない").toMatch(/workspace=不明/);
  });

  it("止まっていなければ、次の一手も言わない", () => {
    // **毎回鳴る案内は、読まれなくなる**（`warn_stale_containers` と同じ判断）
    const { dir } = workspace();
    records(dir, [
      [8_000, "cron"],
      [9_800, "cron"],
    ]);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.status, `${done.stdout}\n${done.stderr}`).toBe(0);
    expect(done.stderr, "止まっていないのに案内している").not.toMatch(/CronList/);
  });

  it("cron が続いているうちは、何も言わない", () => {
    // **上の 1 件が「突かれただけ」で赤いことを、ここが支えている**
    const { dir } = workspace();
    records(dir, [
      [8_000, "cron"],
      [9_800, "cron"],
    ]);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.status, `${done.stdout}\n${done.stderr}`).toBe(0);
    expect(done.stdout, "止まっていないのに言っている").not.toMatch(/stale/);
  });

  it("どう始まったかを渡さなかった周回は、cron と数えない", () => {
    // **判定不能を「動いていた」へ倒さない**——**倒すと、渡し忘れた日から何も見なくなる**
    const { dir } = workspace();
    records(dir, [
      [1_000, "cron"],
      [9_900, "unknown"],
    ]);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.status, "不明なものを cron と数えている").toBe(1);
    expect(done.stdout, "不明が見えない").toMatch(/last_unknown=9900/);
  });

  it("間隔が分からなければ、分からないと答える", () => {
    // **0 件と混ぜない** (#304 と同じ向き)——**「まだ判定できない」を「異常なし」に
    // しない**。**間隔は、ループを起動した人が決めたもの**である
    const { dir } = workspace();
    records(dir, [[1_000, "cron"]]);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000" });

    expect(done.status, "分からないのに答えている").toBe(2);
    expect(done.stderr + done.stdout, "分からないと言っていない").toMatch(/interval=unknown/);
  });

  describe("間隔が渡されていなくても、止まったことに気づく（#438）", () => {
    // **足した案内は `stale` のときだけ出る**（#430 / #433 / #435）——**その `stale` に、
    // 実物では到達していなかった。** **間隔（`LOOP_CRON_INTERVAL_SEC`）を渡すのは
    // 試験だけ**で、**実物は 3 つとも `unknown`** だった。
    //
    // **間隔はリポジトリへ固定しない**（#378 / `AGENTS.md` §1）——**記録から測る。**
    // **測るのは、いちばん短い間**である（**落とした回は間が広がるだけ**なので、
    // **最小が周期にいちばん近い**）。

    it("記録から測った間隔で、止まったと言える", () => {
      const { dir } = workspace();
      records(dir, [
        [1_000, "cron"],
        [2_800, "cron"],
        [4_600, "cron"],
      ]);

      const done = cadence(dir, { LOOP_CADENCE_NOW: "10000" });

      expect(done.status, "止まっていると言っていない").toBe(1);
      expect(done.stdout, "止まっていると言っていない").toMatch(/stale/);
    });

    it("過去に長く空いた記録があっても、窓を広げない", () => {
      // **いちばん長い間を物差しにすると、過去の欠落がそのまま窓になる**
      // （#439 のレビュー）——**1 度 3 時間空いた記録があると、次の停止は 6 時間
      // 経つまで `ok`** で、**その記録が押し出されるまで最大 20 回続く。**
      //
      // **止めるために足したものが、止めなくなる**——**いちばん短い間を採る**
      // （**ただし、呼び直しの数十秒は周期ではない**ので、下限で外す）。
      const { dir } = workspace();
      records(dir, [
        [1_000, "cron"],
        [2_800, "cron"],
        [13_600, "cron"], // **過去に 3 時間空いた**（落ちていた）
        [15_400, "cron"],
      ]);

      const done = cadence(dir, { LOOP_CADENCE_NOW: "20800" });

      expect(done.status, "過去の欠落で、窓が広がっている").toBe(1);
      expect(done.stdout, "止まっていると言っていない").toMatch(/stale/);
    });

    it("物差しが実測だと分かる形で出す", () => {
      // **渡された間隔と混ぜない**——**読む人が、どちらで判定したか分かるように。**
      // **「間隔」とは呼ばない**（**測ったのは、これまで空いた最長の間**である）
      const { dir } = workspace();
      records(dir, [
        [1_000, "cron"],
        [2_800, "cron"],
      ]);

      const done = cadence(dir, { LOOP_CADENCE_NOW: "10000" });

      expect(done.stdout, "実測の物差しだと分からない").toMatch(/interval=~1800/);
    });

    it("捨てて呼び直した周回で、窓が縮まない", () => {
      // **同じ cron の中で 2 回 `acquire` する**（**入口が入れ替わると捨てて呼び直す**）
      // ——**その間は数十秒**である。**いちばん短い間を周期と読むと、窓が数十秒になり、
      // 正常な周回で鳴り続ける**（**実測の `35 49` がそれ**）。
      const { dir } = workspace();
      records(dir, [
        [1_000, "cron"],
        [1_035, "cron"], // **同じ cron の中の 2 回目**（捨てて呼び直した）
        [2_835, "cron"],
        [4_635, "cron"],
      ]);

      const done = cadence(dir, { LOOP_CADENCE_NOW: "6000" });

      expect(done.status, `${done.stdout}\n${done.stderr}`).toBe(0);
      expect(done.stdout, "呼び直しの間で窓を作っている").toMatch(/interval=~1800/);
    });

    it("来ているうちは、測った間隔でも言わない", () => {
      const { dir } = workspace();
      records(dir, [
        [6_400, "cron"],
        [8_200, "cron"],
        [9_800, "cron"],
      ]);

      const done = cadence(dir, { LOOP_CADENCE_NOW: "10000" });

      expect(done.status, `${done.stdout}\n${done.stderr}`).toBe(0);
      expect(done.stdout, "来ているのに止まったと言っている").not.toMatch(/stale/);
    });

    it("渡された間隔があれば、そちらを使う", () => {
      // **測った値で上書きしない**——**起動した人が決めたものが正**である（#378）
      const { dir } = workspace();
      records(dir, [
        [1_000, "cron"],
        [2_800, "cron"],
        [4_600, "cron"],
      ]);

      const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "100000" });

      expect(done.status, `${done.stdout}\n${done.stderr}`).toBe(0);
      expect(done.stdout, "渡された間隔を使っていない").toMatch(/interval=100000/);
    });
  });

  it("記録が無い作業場は、始まっていない側に数える", () => {
    // **居るはずの作業場に記録が無いのは「1 度も始まっていない」**である
    // ——**「まだ分からない」へ倒すと、足したばかりの worker が永久に見えない**
    const { dir } = workspace();

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.status, "始まっていないのに黙っている").toBe(1);
    expect(done.stdout, "始まっていないと言っていない").toMatch(/never/);
  });

  it("作業場の一覧を読めなければ、分からないと答える", () => {
    // **0 件と混ぜない**——**読めないことを「どこも回っていない」にも
    // 「異常なし」にもしない**
    const { dir } = workspace();
    writeFileSync(join(dir, "task"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.status, "読めないのに答えている").toBe(2);
  });

  it("実際に始めた周回が読める", () => {
    // **書く側（`bin/loop-lease`）と読む側（`bin/loop-cadence`）を留める**——
    // **書式を写した試験だけだと、片方を直したときに緑のまま食い違う**
    const { dir, stamp } = workspace();
    round(dir, stamp, "cron");

    const done = cadence(dir, { LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.status, `${done.stdout}\n${done.stderr}`).toBe(0);
    expect(done.stdout, "いま始めた周回が読めていない").toMatch(/last_cron=[0-9]{10}/);
  });

  it("突かれただけの作業場は、実物でも止まっていると言う", () => {
    // **人が突けば周回は回る**ので、**cron を数えないと今回と同じ「健全」に見える**
    const { dir, stamp } = workspace();
    round(dir, stamp, "poke");

    const done = cadence(dir, { LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.status, "突かれただけで動いていることにしている").toBe(1);
    expect(done.stdout, "cron が無いことが読めない").toMatch(/last_cron=-/);
  });

  it("古い読み手を壊さない", () => {
    // **記録は版をまたいで共有される**（`AGENTS.md` §5）——**周回の印（rounds）に
    // 列を足すと、前の版がそこを別の意味で読む。** **足すのは別のファイルである。**
    const { dir, stamp } = workspace();
    round(dir, stamp, "cron");

    const alive = spawnSync(join(dir, "bin/loop-stall"), ["--alive-workers"], {
      cwd: dir,
      encoding: "utf8",
    });

    expect(alive.status, alive.stderr).toBe(0);
    expect(alive.stdout.trim(), "前の版の読み手が数えられない").toMatch(/^[0-9]+$/);
  });
});

/**
 * **手順とスクリプトが噛み合っていること**（#378）。
 *
 * **記録は「周回が始まったとき」に書かれる**ので、**入口が渡さなければ何も残らない**
 * ——**書く側だけ直しても、渡す側が古いままなら、この仕組みは働かない。**
 */
describe("手順と表示が、この記録につながっている", () => {
  it("入口が、どう始まったかを渡している", () => {
    const entry = readFileSync(join(REPO_ROOT, ".claude/commands/loop-worker.md"), "utf8");
    const acquire = entry
      .split("\n")
      .filter((line) => line.includes("bin/loop-lease acquire worker"));

    expect(acquire.length, "入口が lease を取っていない").toBeGreaterThan(0);
    expect(acquire[0], "どう始まったかを渡していない").toContain("--trigger");
  });

  it("人が見るところに出している", () => {
    const runner = readFileSync(join(REPO_ROOT, "task"), "utf8");

    expect(runner, "`./task loop:status` から見えない").toContain("bin/loop-cadence");
    expect(runner.split("cmd_loop_status() {")[1] ?? "", "status から呼んでいない").toContain(
      "show_cadence",
    );
  });

  it("次の一手が、人が見るところまで届く", () => {
    // **案内は stderr へ出す**（#430）——**`./task loop:status` が捨てていると、
    // そこから読む人には届かない。** **判定を持つところに置いた意味が消える。**
    const runner = readFileSync(join(REPO_ROOT, "task"), "utf8");
    const shown = runner.slice(runner.indexOf("show_cadence() {")).split("\n}")[0] ?? "";

    expect(shown, "cadence の stderr を捨てている").toContain("2>&1");
  });

  it("判定できなくても、その先の表示を止めない", () => {
    // **`set -e` の下では、代入の失敗がそのまま打ち切りになる**——**判定できない側で
    // 止まると、この下の全部（STOP・PR・Issue）が出なくなる**（実測で踏んだ）
    const runner = readFileSync(join(REPO_ROOT, "task"), "utf8");
    const shown = runner.slice(runner.indexOf("show_cadence() {")).split("\n}")[0] ?? "";
    const dir = mkdtempSync(join(tmpdir(), "loop-cadence-status-"));
    sandboxes.push(dir);
    mkdirSync(join(dir, "bin"), { recursive: true });
    // **判定できない側で返す**（`bin/loop-cadence` の exit 2）
    writeFileSync(join(dir, "bin", "loop-cadence"), "#!/usr/bin/env bash\nexit 2\n", {
      mode: 0o755,
    });

    const done = spawnSync("bash", ["-e", "-c", `${shown}\n}\nshow_cadence\necho つづき`], {
      cwd: dir,
      encoding: "utf8",
    });

    expect(done.stdout, "判定できない側で打ち切られている").toContain("つづき");
  });
});

/**
 * **残る側を数える**（#381 のレビュー。`AGENTS.md` §5）。
 *
 * **足したのは worker の入口だけ**である——**master の入口は `--trigger` を渡さない**ので、
 * **その記録を読むと `unknown` になり、worker の cron が正常でも `stale` が立つ。**
 * **見えるようにするために足した行が、嘘を言うことになる。**
 *
 * **消えた作業場も残る**——**`.git` の共通ディレクトリは worktree をまたいで 1 つ**なので、
 * **`./task loop:worker:remove` で消しても記録は残る。**
 */
describe("読む先を、この仕組みが届く範囲に限る", () => {
  it("master の記録も読む", () => {
    // **#381 では読まなかった**——**master の入口が `--trigger` を渡していなかった**
    // ので、**読むと `unknown` になり、worker の cron が正常でも `stale` が立った。**
    // **渡すようになったので、読む**（#422）——**判定は worker と同じもの。**
    const { dir } = workspace();
    records(dir, [[9_900, "cron"]]);
    records(dir, [[9_900, "cron"]], dir, "master");

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.status, `${done.stdout}\n${done.stderr}`).toBe(0);
    expect(done.stdout, "master の記録を読んでいない").toMatch(/scope=master/);
  });

  it("消えた作業場の記録では、止まっていると言わない", () => {
    // **消した作業場は、回っていないのが正しい**——**残った記録で人を呼ばない**
    // **一覧に出てこない**（`./task loop:worker:paths` は登録されているものを並べる）
    const { dir } = workspace();
    records(dir, [[9_900, "cron"]]);
    writeFileSync(
      join(dir, ".git", "valence-loop-starts-worker-消えたほう"),
      `1000\tcron\t${join(dir, "居ない作業場")}\n`,
    );

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.status, "消えた作業場で誤報している").toBe(0);
  });

  it("居る作業場のぶんは、これまでどおり読む", () => {
    // **上の 2 件が「読まない」で緑になっていないこと**を、ここが支えている
    const { dir } = workspace();
    records(dir, [[1_000, "cron"]], dir);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.status, "居る作業場を読み飛ばしている").toBe(1);
  });
});

describe("入口が、通るすべての口で渡している", () => {
  it("acquire も recover も、どう始まったかを渡す", () => {
    // **`--trigger` が最初の `acquire` にしかない**と、**回復と読み直しの経路
    // （#374）で記録が `unknown` になる**——**その道はこの 2 日で何度も通っている**
    const entry = readFileSync(join(REPO_ROOT, ".claude/commands/loop-worker.md"), "utf8");
    const taking = entry
      .split("\n")
      .filter((line) => /bin\/loop-lease (acquire|recover) worker/.test(line));

    expect(taking.length, "lease を取る口が見つからない").toBeGreaterThanOrEqual(3);
    for (const line of taking) {
      expect(line, `どう始まったかを渡していない: ${line}`).toContain("--trigger");
    }
  });
});

/**
 * **居るはずのものを数える**（#381 のレビュー 2 周目）。
 *
 * **走査が並べていたのは、既にある記録だけ**だった——**`./task loop:worker:add` で
 * 足した作業場が 1 度も lease を取れていなければ、ファイルが無いので列に出てこない。**
 * **`found=1` は他の作業場が立てる**ので、**健全な worker が 1 つでもあれば exit 0** に
 * なる。**「1 度も始まっていない worker」が、いちばん見落とされる**——
 * **この Issue が消しに来たものそのもの**である。
 */
/**
 * **足したばかりの作業場**（`./task loop:worker:add` と同じ形）。
 *
 * **作業場は worktree である**——**サブディレクトリでは、名前（scope）が
 * 根と同じになる**ので、**「記録が無い作業場」の入力にならない。**
 */
function addedWorkspace(dir: string): string {
  const added = `${dir}-worker-b`;
  sandboxes.push(added);
  // **worktree を作るには commit が要る**（未出生のブランチからは作れない）
  const seeded = spawnSync(
    "git",
    [
      "-c",
      "user.email=loop@example.invalid",
      "-c",
      "user.name=loop",
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "seed",
    ],
    { cwd: dir, encoding: "utf8" },
  );
  expect(seeded.status, seeded.stderr).toBe(0);
  const done = spawnSync(
    "git",
    [
      "-c",
      "user.email=loop@example.invalid",
      "-c",
      "user.name=loop",
      "worktree",
      "add",
      "--detach",
      "--quiet",
      added,
      "HEAD",
    ],
    { cwd: dir, encoding: "utf8" },
  );
  expect(done.status, done.stderr).toBe(0);
  return added;
}

/** **どこに作業場が居るかを答える口**を差し替える（本物は `./task` が持つ）。 */
function withWorkspaceList(dir: string, paths: string[]): void {
  taskAnswers(dir, { workerPaths: paths });
}

describe("居るはずの作業場を、記録が無くても数える", () => {
  it("1 度も始まっていない作業場を、止まっている側に数える", () => {
    // **記録が無いのは「始まっていない」**である——**列から落とすと、
    // 足したばかりの worker が永久に見えない**
    const { dir } = workspace();
    records(dir, [[9_900, "cron"]]);
    const fresh = addedWorkspace(dir);
    withWorkspaceList(dir, [dir, fresh]);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.status, "記録の無い作業場が見えていない").toBe(1);
    expect(done.stdout + done.stderr, "始まっていないと言っていない").toMatch(/never|始まって/);
  });

  it("正常な worker が居ても、隠れない", () => {
    // **`found` を他の作業場が立てる**ので、**1 つでも健全なら exit 0 になっていた**
    const { dir } = workspace();
    records(dir, [[9_900, "cron"]]);
    const fresh = addedWorkspace(dir);
    withWorkspaceList(dir, [dir, fresh]);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.stdout, "健全なほうが読めない").toMatch(/last_cron=9900/);
    expect(done.status, "健全なほうに隠されている").toBe(1);
  });

  it("全部が回っていれば、これまでどおり何も言わない", () => {
    // **上の 2 件が「記録が無いこと」で赤いことを、ここが支えている**
    const { dir } = workspace();
    records(dir, [[9_900, "cron"]]);
    withWorkspaceList(dir, [dir]);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.status, `${done.stdout}\n${done.stderr}`).toBe(0);
  });

  it("どこに作業場が居るかを、自分で決めない", () => {
    // **足す側と数える側で規則が食い違う**（`./task loop:worker:add` は
    // `${PWD}-worker-<名前>`、master は `${PWD}-master`）——**写さない**
    const script = readFileSync(join(REPO_ROOT, "bin/loop-cadence"), "utf8");

    expect(script, "作業場の並べ方を書き写している").not.toMatch(/-worker-|git worktree list/);
    expect(script, "外の口を呼んでいない").toContain("loop:worker:paths");
  });
});

describe("作業場を並べる口", () => {
  function paths(): string[] {
    const done = spawnSync("./task", ["loop:worker:paths"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(done.status, done.stderr).toBe(0);
    return done.stdout.trim().split("\n").filter(Boolean);
  }

  it("master の作業場を、worker に数えない", () => {
    // **1 件目の直しと同じ理由**——**master の入口は `--trigger` を渡さない**
    expect(
      paths().filter((path) => path.endsWith("-master")),
      "master を数えている",
    ).toEqual([]);
  });

  it("いま登録されている作業場から並べる", () => {
    // **`git worktree list` が正**である（`./task loop:stop-paths` と同じ口）
    expect(paths().length, "1 つも並べていない").toBeGreaterThanOrEqual(1);
  });
});

/**
 * **確定したものは、確定していないものに負けない**（#381 のレビュー 3 周目）。
 *
 * **間隔が要るのは「どれだけ経ったら古いか」だけ**である——**cron の記録が 1 本も
 * 無いことは、間隔を知らなくても言える。** **現に `never` は間隔を見ずに答えている**
 * のに、**記録が 1 行でもあると `unknown` へ移っていた**——**人が 1 回突くと、
 * その作業場は `stale` から `unknown` へ落ちる**（**「突かれて動いた日が健全に
 * 見える」の軽い版**）。
 */
describe("間隔が分からなくても、言えることは言う", () => {
  it("cron の記録が無ければ、間隔を知らなくても止まっていると言う", () => {
    const { dir } = workspace();
    records(dir, [[9_000, "poke"]]);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000" });

    expect(done.status, "間隔が無いと黙っている").toBe(1);
    expect(done.stdout, "止まっていると言っていない").toMatch(/stale/);
  });

  it("cron の記録があるなら、間隔が無い側はこれまでどおり分からない", () => {
    // **上の 1 件が「cron が無いこと」で赤いことを、ここが支えている**
    const { dir } = workspace();
    records(dir, [[9_000, "cron"]]);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000" });

    expect(done.status, "間隔なしで古さを決めている").toBe(2);
  });

  it("確定した「止まっている」は、判定できない作業場に隠れない", () => {
    // **見出しは終了コードだけで決まる**ので、**確定した異常が、確定していない
    // ものに負けると、人は「判定できません」しか読まない**
    const { dir } = workspace();
    const other = addedWorkspace(dir);
    records(dir, [[9_000, "cron"]]); // 間隔が無いので unknown
    withWorkspaceList(dir, [dir, other]); // other は記録なし → never

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000" });

    expect(done.status, "確定した止まりが隠れている").toBe(1);
    expect(done.stdout, "両方出ていない").toMatch(/never/);
    expect(done.stdout, "判定できない側も出ていない").toMatch(/unknown/);
  });
});

/**
 * **長い周回は「来ていない」ではなく「終わっていない」**（#381 のレビュー 4 周目）。
 *
 * **`acquire` が記録を書くのは、取れたときだけ**である——**前の周回がまだ走っていると、
 * 次の cron は「走っている周回がある」で何もせず終わる**ので、**記録は 1 行も増えない。**
 * **周回が間隔の 2 倍を超えると、cron は鳴り続けているのに `stale` になる。**
 *
 * **#378 が消しに来たのは「外から見た印が、実際と違うこと」**である——
 * **向きが逆なだけで、同じ誤診**である。
 */
describe("長い周回を、来ていないと言わない", () => {
  /** その作業場でいちばん長かった周回の秒数（`bin/loop-lease` が書く）。 */
  function roundLength(dir: string, seconds: number): void {
    const scope = spawnSync(join(dir, "bin/loop-lease"), ["scope", "worker"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(scope.status, scope.stderr).toBe(0);
    writeFileSync(
      join(dir, ".git", `valence-loop-roundlen-${scope.stdout.trim()}`),
      `${seconds}\n`,
    );
  }

  it("間隔の 2 倍より長い周回が走っていても、止まっているとは言わない", () => {
    // **実測があるなら、それで窓を広げる**（`bin/loop-lease alive` と同じもの）
    const { dir } = workspace();
    records(dir, [[5_000, "cron"]]);
    roundLength(dir, 4_800);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.status, "終わっていないのを「来ていない」と言っている").toBe(0);
  });

  it("長い周回の実測があっても、本当に止まっていれば言う", () => {
    // **「長いかもしれない」で全部を黙らせない**——**広げるのは実測のぶんだけ**
    const { dir } = workspace();
    records(dir, [[500, "cron"]]);
    roundLength(dir, 4_800);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.status, "止まっているのに黙っている").toBe(1);
  });

  it("周回の長さが分からなければ、これまでどおり間隔で見る", () => {
    // **実測が無いときに広げると、この仕組みが何も言わなくなる**
    const { dir } = workspace();
    records(dir, [[5_000, "cron"]]);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.status, "実測が無いのに広げている").toBe(1);
  });
});

/**
 * **master の周回が来ているかを、誰も測れなかった**（#422）。
 *
 * **入口が `--trigger` を渡さないので、記録はすべて `unknown`** だった
 * ——**22:22 から 00:06 まで master の周回が 1 つも無く、その間、持ち手が master の
 * PR が「ゲートを回せる」状態で止まっていた**（2026-08-23。**人が気づいて突いた**）。
 * **そして、なぜ空いたのかが分からない**（**鳴らなかった / `acquire` が exit 1 で
 * 終わった / 届かなかった**）。
 *
 * **#378 が worker に対して直したのと同じ形**である。**判定は 1 つ**で、
 * **見る先が 1 つ増えるだけ。**
 */
describe("master の周回も見る", () => {
  it("master が cron で回っていれば、何も言わない", () => {
    const { dir } = workspace();
    records(dir, [[9_800, "cron"]]);
    records(dir, [[9_800, "cron"]], dir, "master");

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.status, `${done.stdout}\n${done.stderr}`).toBe(0);
    expect(done.stdout, "master を見ていない").toMatch(/scope=master/);
  });

  it("master が突かれただけなら、止まっていると言う", () => {
    // **これが実測の形である**——**人が突けば周回は回るので、外からは健全に見える**
    const { dir } = workspace();
    records(dir, [[9_800, "cron"]]);
    records(
      dir,
      [
        [1_000, "cron"],
        [9_900, "poke"],
      ],
      dir,
      "master",
    );

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.status, "master が止まっているのに黙っている").toBe(1);
    expect(done.stdout, "master が止まっていると言っていない").toMatch(/scope=master.*stale/);
  });

  it("どう始まったかを渡していない master の周回は、cron と数えない", () => {
    // **いまがその状態である**（**記録はすべて `unknown`**）——**渡すようになるまでは
    // 「分からない」ではなく「来ていない」側**である（#378 と同じ倒し方）
    const { dir } = workspace();
    records(dir, [[9_800, "cron"]]);
    records(dir, [[9_900, "unknown"]], dir, "master");

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.status, "unknown を cron と数えている").toBe(1);
    expect(done.stdout, "不明が見えない").toMatch(/scope=master.*last_unknown=9900/);
  });

  it("master の作業場があって記録が無ければ、始まっていない側に数える", () => {
    // **足したばかりの master が永久に見えない**のを防ぐ（worker と同じ）
    const { dir } = workspace();
    records(dir, [[9_800, "cron"]]);
    taskAnswers(dir, { workerPaths: [dir], masterPath: dir });

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.status, "始まっていないのに黙っている").toBe(1);
    expect(done.stdout, "master が never だと言っていない").toMatch(/scope=master.*never/);
  });

  it("master が居ないループでは、master のことを言わない", () => {
    // **作業場も記録も無いなら、この loop に master は居ない**
    // ——**居ないものを「止まっている」と言うと、読む人が探しに行く**
    const { dir } = workspace();
    records(dir, [[9_800, "cron"]]);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.status, `${done.stdout}\n${done.stderr}`).toBe(0);
    expect(done.stdout, "居ない master のことを言っている").not.toMatch(/scope=master/);
  });
});
