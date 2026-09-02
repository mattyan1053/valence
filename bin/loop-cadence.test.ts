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

/**
 * **握っていた時間を置く**（#575）。**枠のとき暇だったかは、始まりだけでは
 * 言えない**——**「始まった」と「終わった」の間が、塞がっていた時間**である。
 *
 * **組で持つ** (#578 のレビュー)——**別々に数えると、対応の付かない始まりが
 * 1 本でもあれば「ずっと握っている」へ倒れたまま戻らない。**
 *
 * **置き場所と書式は `bin/loop-lease` が決める**ので、**実際に返した周回が
 * 書いたものを読めること**（`実際に返した周回が読める`）で両端を留めてある。
 */
function held(dir: string, spans: [number, number][], role = "worker"): void {
  const scope = spawnSync(join(dir, "bin/loop-lease"), ["scope", role], {
    cwd: dir,
    encoding: "utf8",
  });
  expect(scope.status, scope.stderr).toBe(0);
  writeFileSync(
    join(dir, ".git", `valence-loop-held-${scope.stdout.trim()}`),
    `${spans.map(([from, to]) => `${from}\t${to}`).join("\n")}\n`,
  );
}

/**
 * **いま周回を回している状態にする**（**返さない**）。**始めた時刻も決める。**
 *
 * **`bin/loop-lease` は始まりを `valence-loop-rounds-<scope>` に書く**——**試験は
 * 決まった時刻から見る**ので、**取ったあとに、その 1 行だけを置き換える。**
 */
function running(dir: string, stamp: string, since: number): void {
  const taken = spawnSync(join(dir, "bin/loop-lease"), ["acquire", "worker", stamp], {
    cwd: dir,
    encoding: "utf8",
  });
  expect(taken.status, taken.stderr).toBe(0);
  const scope = spawnSync(join(dir, "bin/loop-lease"), ["scope", "worker"], {
    cwd: dir,
    encoding: "utf8",
  });
  expect(scope.status, scope.stderr).toBe(0);
  writeFileSync(
    join(dir, ".git", `valence-loop-rounds-${scope.stdout.trim()}`),
    `${since}\n${dir}\n`,
  );
}

function cadence(dir: string, env: Record<string, string> = {}, args: string[] = []) {
  return spawnSync(join(dir, "bin/loop-cadence"), args, {
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
    // **次の一手は行ごとに違う** (#497)——**案内はそこへ向ける**（下の 4 件が中身を見る）。
    // **見出しの行だけを見る**（`AGENTS.md` §4）——**`読み=` は案内の中に 2 行あり**、
    // **stderr 全体に当てると、見出しから消しても、もう 1 行が受けて緑になる**（実測）。
    const warn = done.stderr.split("\n").find((line) => line.startsWith("[WARN]")) ?? "";
    expect(warn, "見出しが 読み= を指していない").toContain("読み=");
    // **限界も同じところに**——**言えるのは「記録に無い」まで**である
    expect(done.stderr, "この記録から言えることの限界が無い").toMatch(/直近/);
    expect(done.stderr, "走っている最中の cron が記録に残らないことが無い").toMatch(/acquire/);
  });

  describe("stale の原因は 2 つある（#497）", () => {
    // **`stale` は「直近の記録に cron の周回が無い」としか言っていない**——**原因は
    // 2 つあり、打つ手が逆である。**
    //
    // - **予定が消えた**（**セッションが死ぬと、そのセッションの予定も消える**。
    //   **recurring は 7 日で期限切れになる**）→ **引いて入れ直す**
    // - **そのセッションが動いていない** → **引く先が居ない**ので、**起こすほうが先**
    //
    // **見分けるのは `last_poke`** である——**cron が生きていれば、突かれずとも
    // 記録が増える。** **2 度あった**（2026-08-24 / 2026-08-25。どちらも前者）。
    //
    // **判定（`ok` / `stale` / `unknown` / `never`）は変えない**——**変えるのは、
    // 出したあとに何を読むか**だけである。

    /** **その行の段だけを見る**（**判定の範囲を本文より狭くする**。`AGENTS.md` §4）。 */
    function section(stdout: string, role: string): string {
      return stdout.split(/^scope=/m).find((part) => part.startsWith(role)) ?? "";
    }

    it("突かれた周回だけが新しいなら、予定表が空だと言う", () => {
      // **これが 2 度とも踏んだ形である**——**人に突かれてしか動いていない。**
      const { dir } = workspace();
      records(dir, [
        [1_000, "cron"],
        [9_500, "poke"],
      ]);

      const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

      expect(done.status, "止まっていると言っていない").toBe(1);
      const row = section(done.stdout, "worker");
      expect(row, "予定表を引けと言っていない").toContain("CronList");
      expect(row, "動いていない側の手を出している").not.toContain("先に起こす");
    });

    it("どちらの周回も新しくないなら、先に起こせと言う", () => {
      // **引く先が居ない**（**セッションが動いていなければ、そこで引くこと自体が
      // できない**）——
      // **ここで「引け」と言うと、読んだ人は空を見て、そこで止まる。**
      const { dir } = workspace();
      records(dir, [
        [1_000, "cron"],
        [5_000, "poke"],
      ]);

      const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

      expect(done.status, "止まっていると言っていない").toBe(1);
      const row = section(done.stdout, "worker");
      expect(row, "先に起こせと言っていない").toContain("先に起こす");
      expect(row, "予定表の側の手を出している").not.toContain("CronList");
    });

    it("cron の記録が 1 本も無くても、突かれていれば予定表の側へ倒す", () => {
      // **窓が分からない**（**cron が 1 本も無いので、記録から周期を測れない**）
      // ——**それでも「予定が入っていない」ことは、窓を知らなくても言える。**
      const { dir } = workspace();
      records(dir, [[9_500, "poke"]]);

      const done = cadence(dir, { LOOP_CADENCE_NOW: "10000" });

      expect(done.status, "止まっていると言っていない").toBe(1);
      const row = section(done.stdout, "worker");
      expect(row, "予定表を引けと言っていない").toContain("CronList");
    });

    it("窓が分からないなら、突かれた周回が新しいとは言わない", () => {
      // **物差しが無い行で「新しい」と断定していた** (#498 のレビュー)。**窓は
      // cron の記録から測る**ので、**cron が 1 本も無い行では決まらない**——
      // **そこで `last_poke` を一切見ずに「突かれた周回だけが新しい」と出していた。**
      //
      // **踏むのは、いちばん様子が分からない側である**——**足したばかりの作業場**
      // （**`set -u` のバグを見つけたのと同じ入力**）が**放っておかれた形**。
      //
      // **分からないことは、分からないと言う。** **予定表の側へ倒すのは変えない**
      // ——**cron の記録が 1 本も無いことは、窓を知らなくても言える**からである。
      const { dir } = workspace();
      records(dir, [[1_000, "poke"]]); // **その poke も十分古い**

      const done = cadence(dir, { LOOP_CADENCE_NOW: "10000" });

      expect(done.status, "止まっていると言っていない").toBe(1);
      const row = section(done.stdout, "worker");
      expect(row, "確かめていないことを断定している").not.toContain("だけが新しい");
    });

    it("どう始まったか分からない周回が新しいなら、動いていないとは言わない", () => {
      // **`--trigger` を渡さない古い手順書から始まった周回は `unknown` に落ちる**
      // (#498 のレビュー 2 周目)——**`show_reading` は `last_poke` しか見ていない**ので、
      // **500 秒前に周回が回っていても「そのセッションが動いていない」と出していた。**
      //
      // **`unknown` を cron と数えないのは変えない**（**渡し忘れた日から何も見なく
      // なる**）——**変えるのは「動いていない」と断定するところだけ**である。
      //
      // **入力はレビューが挙げたもの**（`last_cron=1000` / `last_unknown=9500` /
      // `NOW=10000` / 間隔 1800）。
      const { dir } = workspace();
      records(dir, [
        [1_000, "cron"],
        [9_500, "unknown"],
      ]);

      const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

      expect(done.status, "止まっていると言っていない").toBe(1);
      const row = section(done.stdout, "worker");
      expect(row, "動いているセッションを、動いていないと言っている").not.toContain("先に起こす");
    });

    it("突かれた周回と、どう始まったか分からない周回が両方新しいなら、予定表が空だとは言わない", () => {
      // **`unknown` は「`--trigger` を渡さずに始まった周回」**である
      // （`bin/loop-lease`）——**古い手順書を配られた周回も通る**ので、
      // **その中に cron の周回が混ざりうる。** **窓の中に `unknown` があるなら、
      // cron が鳴っていた可能性が残る**——**「予定表が空である」とは言えない。**
      //
      // **踏むのは、手順書が入れ替わる最中**である（**この repo が毎日やっている**）
      // ——**古い版で始まった周回と、新しい版で始まった周回が、同じ窓に並ぶ。**
      const { dir } = workspace();
      records(dir, [
        [1_000, "cron"],
        [9_500, "poke"],
        [9_600, "unknown"],
      ]);

      const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

      expect(done.status, "止まっていると言っていない").toBe(1);
      const row = section(done.stdout, "worker");
      expect(row, "確かめていないことを断定している").not.toContain("予定表が空である");
    });

    it("鳴ったが走れなかった cron も、鳴った証拠として数える", () => {
      // **踏んだ** (#536)。**忙しい作業場は `stale` に見え続ける**——**鳴っていない
      // からではなく、記録が増えないから**である（**走っている最中に鳴った cron は
      // `acquire` で終わる**）。**4 回突かれて、4 回とも「空ではない」だった。**
      //
      // **`cron-blocked` は「鳴ったが走れなかった」**である——**予定表は生きている。**
      const { dir } = workspace();
      records(dir, [
        [1_000, "cron"],
        [9_500, "cron-blocked"],
      ]);

      const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

      expect(done.status, "走っているだけの作業場を止まっていると言っている").toBe(0);
      expect(section(done.stdout, "worker"), "止まっていると出ている").toContain(" ok");
    });

    it("鳴ったことが何回あったかを、行に出す", () => {
      // **「exit 1 で終わった cron が何回あったか」は、記録が無かった** (#536 の
      // 「分かっていないこと」)——**数えられる形にする。**
      const { dir } = workspace();
      records(dir, [
        [1_000, "cron"],
        [9_400, "cron-blocked"],
        [9_500, "cron-blocked"],
      ]);

      const row = section(
        cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" }).stdout,
        "worker",
      );

      expect(row, "鳴ったが走れなかった回数が読めない").toContain("blocked=2");
    });

    it("鳴っていなければ、これまでどおり止まっていると言う", () => {
      // **消してはいけないほう**——**本当に予定表が空になった日は、これまでどおり出る。**
      const { dir } = workspace();
      records(dir, [
        [1_000, "cron"],
        [9_500, "poke"],
      ]);

      const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

      expect(done.status, "止まっているのに言っていない").toBe(1);
      expect(section(done.stdout, "worker"), "鳴っていないのに数えている").not.toContain(
        "blocked=",
      );
    });

    it("突かれた周回だけが新しくても、予定表が空だとは断定しない", () => {
      // **踏んだ** (#531)。**この読みに従って master が「入れ直してください」と指示し**、
      // **引いたら空ではなかった**——**登録は生きていて、刻みも 30 分だった。**
      //
      // **本当の原因は「セッションが塞がっていた」**である——**cron はセッションが
      // 暇なときにしか発火しない**（**道具の説明**）。**`./task check` が 1 本 7〜8 分**、
      // **レビュー対応が続けば、1.7 時間 cron が鳴らない。**
      //
      // **見分けはこの道具では付かない**（**他のセッションを引けない**、と自分で書いてある）
      // ——**断定をやめて、引いた結果で分かれる形にする。**
      const { dir } = workspace();
      records(dir, [
        [1_000, "cron"],
        [9_500, "poke"],
      ]);

      const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

      expect(done.status, "止まっていると言っていない").toBe(1);
      const row = section(done.stdout, "worker");
      expect(row, "確かめていないことを断定している").not.toContain("予定表が空である");
    });

    it("突かれた周回だけが新しいなら、引いて見るように言う", () => {
      // **隣の枝は既にそう書いてある**（「引いて見る（CronList）」）
      const { dir } = workspace();
      records(dir, [
        [1_000, "cron"],
        [9_500, "poke"],
      ]);

      const row = section(
        cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" }).stdout,
        "worker",
      );

      expect(row, "引く先が出ていない").toContain("CronList");
    });

    it("引いた結果で、行き先が分かれる", () => {
      // **完了条件**——**空だった / 空でなかった、の両方に行き先があること。**
      // **塞がっているセッションは、突いても意味が無い**（**いずれ回る**）。
      const { dir } = workspace();
      records(dir, [
        [1_000, "cron"],
        [9_500, "poke"],
      ]);

      const row = section(
        cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" }).stdout,
        "worker",
      );

      expect(row, "空だったときの行き先が無い").toContain("空なら");
      expect(row, "空でなかったときの行き先が無い").toContain("空でなければ");
    });

    it("1 度も始まっていない作業場にも、次の一手を出す", () => {
      // **`never` も止まっている側**である（**足したばかりの worker がここへ来る**）
      // ——**記録が 1 行も無いので、引く先のセッションがそもそも居ない。**
      const { dir } = workspace();

      const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

      expect(done.status, "始まっていないと言っていない").toBe(1);
      const row = section(done.stdout, "worker");
      expect(row, "never の行に次の一手が無い").toContain("先に起こす");
    });
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
    // **master の段だけを見る**（#441 の置き手紙）——**`[\s\S]*` だと後ろ全部を跨ぐ**ので、
    // **別の作業場が出した `workspace=` を拾って緑になりうる**（`AGENTS.md` §4。
    // **判定の範囲を本文より狭くする**）。**並び順にも寄りかからない。**
    const masterSection =
      done.stdout.split(/^scope=/m).find((section) => section.startsWith("master")) ?? "";

    expect(masterSection, "master の行に道が無い").toContain("workspace=");
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
    expect(done.stderr, "止まっていないのに案内している").not.toMatch(/次の一手/);
    // **読みも止まっている行にだけ出す** (#497)——**毎回出ると、案内ごと読まれなくなる**
    expect(done.stdout, "止まっていないのに読みを出している").not.toContain("読み=");
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

    it("間隔を長いほうへ変えたら、待っている間は言わない", () => {
      // **#441 そのもの**——**5 分 → 30 分に変えると、前の周期の 300 秒が記録に残る。**
      // **窓は 600 秒**なので、**次の cron を正しく待っている途中で `stale`** になり、
      // **古い記録が押し出されるまで最大 20 回続く。**
      //
      // **記録からは、周期が伸びたのか、鳴り損ねたのかを見分けられない**
      // ——**同じ形に見える。** **だから、直前の間が長かったなら、その 1 回ぶんは待つ。**
      const { dir } = workspace();
      records(dir, [
        [1_000, "cron"],
        [1_300, "cron"],
        [1_600, "cron"],
        [1_900, "cron"], // ここまで 5 分周期
        [3_700, "cron"], // 30 分へ変えた（最初の 1 本）
      ]);

      // **正しく待っている途中**（次の cron は 5_500 に来る）
      const done = cadence(dir, { LOOP_CADENCE_NOW: "5400" });

      expect(done.status, `止まっていないのに言っている: ${done.stdout}`).toBe(0);
      expect(done.stdout, "止まっていないのに言っている").not.toMatch(/stale/);
    });

    it("長いほうへ変えても、そのまま止まれば言う", () => {
      // **待つのは 1 回ぶんだけ**である——**「変わったかもしれない」で、いつまでも黙らない。**
      const { dir } = workspace();
      records(dir, [
        [1_000, "cron"],
        [1_300, "cron"],
        [1_600, "cron"],
        [1_900, "cron"],
        [3_700, "cron"],
      ]);

      const done = cadence(dir, { LOOP_CADENCE_NOW: "9000" });

      expect(done.status, "止まったのに黙っている").toBe(1);
      expect(done.stdout, "止まったのに黙っている").toMatch(/stale/);
    });

    it("間隔を短いほうへ変えたら、黙らない", () => {
      // **逆向きも開けない**（#441 の注意）——**長いほうから短いほうへ変えたときに
      // 物差しが大きいままだと、止まっても黙る。**
      const { dir } = workspace();
      records(dir, [
        [1_000, "cron"],
        [2_800, "cron"], // 30 分周期
        [3_100, "cron"], // 5 分へ変えた
        [3_400, "cron"],
      ]);

      const done = cadence(dir, { LOOP_CADENCE_NOW: "4200" });

      expect(done.status, "短くしたのに、古い物差しで黙っている").toBe(1);
      expect(done.stdout, "止まったと言っていない").toMatch(/stale/);
    });

    it("長い周回の最中は、その周回のぶんだけ待つ", () => {
      // **走っている最中に鳴った cron は `acquire` で終わる**ので、**記録が 1 行も
      // 増えない**（#444）——**その周回の中に入った刻みは、周回が説明する。**
      const { dir, stamp } = workspace();
      records(dir, [
        [1_000, "cron"],
        [2_800, "cron"],
        [4_600, "cron"],
      ]);
      // **4_700 から回している**（**回していなければ、この age は `stale` である**）
      running(dir, stamp, 4_700);

      const done = cadence(dir, { LOOP_CADENCE_NOW: "9000", LOOP_CRON_INTERVAL_SEC: "1800" });

      expect(done.stdout, "周回が説明できるぶんまで言っている").not.toMatch(/stale/);
      expect(done.status, `${done.stdout}\n${done.stderr}`).toBe(0);
    });

    it("短い周回の最中でも、それより古い沈黙は言う", () => {
      // **`bin/loop-cadence` は周回の中から呼ばれる**ので、**呼んだ役は必ず自分の
      // lease を握っている**（#446 のレビュー）——**「回っている」と「cron が生きて
      // いる」は別**である。**2 分前に始まった周回は、60 分前からの沈黙を説明しない。**
      const { dir, stamp } = workspace();
      records(dir, [
        [1_000, "cron"],
        [2_800, "cron"],
        [4_600, "cron"],
      ]);
      running(dir, stamp, 8_880); // **2 分前に始めたばかり**

      const done = cadence(dir, { LOOP_CADENCE_NOW: "9000", LOOP_CRON_INTERVAL_SEC: "1800" });

      expect(done.status, "自分の周回で、自分の stale を隠している").toBe(1);
      expect(done.stdout, "止まったと言っていない").toMatch(/stale/);
    });

    it("回していないなら、これまでどおり止まったと言う", () => {
      // **上の 2 件が「周回が説明するから」で緑なことを、ここが支えている**
      const { dir } = workspace();
      records(dir, [
        [1_000, "cron"],
        [2_800, "cron"],
        [4_600, "cron"],
      ]);

      const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

      expect(done.status, "止まっているのに黙っている").toBe(1);
      expect(done.stdout, "止まったと言っていない").toMatch(/stale/);
    });

    it("渡された間隔なら、記録の大きな間で窓を広げない", () => {
      // **「渡されたものが正」**である（#378。#443 のレビュー）——**測るのは渡されて
      // いないときだけ**なのに、**窓のほうが記録の間で広がっていた。**
      // **倒れる向きは「黙る」側**（**窓が広がって `ok`**）である。
      const { dir } = workspace();
      records(dir, [
        [1_000, "cron"],
        [10_000, "cron"], // **9000 秒空いている**（落ちていた）
      ]);

      const done = cadence(dir, { LOOP_CADENCE_NOW: "15000", LOOP_CRON_INTERVAL_SEC: "1800" });

      expect(done.status, "渡された間隔なのに、記録で窓が広がっている").toBe(1);
      expect(done.stdout, "止まったと言っていない").toMatch(/stale/);
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

  it("走れなかった cron も、実物で読める", () => {
    // **両端を留める** (#536)——**書く側（`bin/loop-lease` が `acquire` を断るとき）と
    // 読む側（ここ）を、実物で繋ぐ。** **書式を写した試験だけだと、片方を直したときに
    // 緑のまま食い違う。**
    const { dir, stamp } = workspace();
    // **1 本目は取ったまま返さない**——**次の cron が断られる状態を作る。**
    const held = spawnSync(
      join(dir, "bin/loop-lease"),
      ["acquire", "worker", stamp, "--trigger", "cron"],
      { cwd: dir, encoding: "utf8" },
    );
    expect(held.status, held.stderr).toBe(0);
    const blocked = spawnSync(
      join(dir, "bin/loop-lease"),
      ["acquire", "worker", stamp, "--trigger", "cron"],
      { cwd: dir, encoding: "utf8" },
    );

    expect(blocked.status, "走っているのに取れている").toBe(1);
    const done = cadence(dir, { LOOP_CRON_INTERVAL_SEC: "1800" });
    expect(done.stdout, "鳴ったが走れなかったことが読めない").toContain("blocked=1");
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
describe("出口から毎回呼ぶ（--quiet）", () => {
  // **予定表が空になったことを、手順で見つける** (#530)。**1 日に 3 回踏み、
  // 3 回とも誰かの気まぐれで見つかった**——**道具は正しく読んでいた**が、
  // **打つ手順が無かった。**
  //
  // **毎回鳴る検査は、そのうち読まれなくなる**（#248）ので、**続いている行は出さない。**

  it("続いているときは、何も出さない", () => {
    const { dir } = workspace();
    records(dir, [
      [1_000, "cron"],
      [2_800, "cron"],
    ]);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "3000", LOOP_CRON_INTERVAL_SEC: "1800" }, [
      "--quiet",
    ]);

    expect(done.status, "止まっていないのに、止まっていると言っている").toBe(0);
    expect(done.stdout, "平常時に鳴っている（そのうち読まれなくなる）").toBe("");
  });

  it("止まっている行は、これまでどおり出す", () => {
    // **突かれた周回だけが続く形**（**実測**）——**外からは動いて見える。**
    const { dir } = workspace();
    records(dir, [
      [1_000, "cron"],
      [9_000, "poke"],
      [9_500, "poke"],
    ]);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" }, [
      "--quiet",
    ]);

    expect(done.status, "止まっていると言っていない").toBe(1);
    expect(done.stdout, "止まっている行が消えている").toMatch(/stale/);
    // **次の一手も消さない**——**行の「読み=」が、打つ手を決める**（#497）
    expect(done.stdout, "次にどこを見るかが消えている").toMatch(/読み=/);
  });

  it("知らない引数は、使い方を出して落ちる", () => {
    // **黙って全部出す側へ倒さない**——**打ち間違いが「平常時に鳴る」に化ける**
    const { dir } = workspace();
    records(dir, [[1_000, "cron"]]);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "1100", LOOP_CRON_INTERVAL_SEC: "1800" }, [
      "--bogus",
    ]);

    expect(done.status, "知らない引数を受けている").toBe(2);
    expect(done.stderr, "使い方が出ていない").toMatch(/--quiet/);
  });
});

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

/**
 * **並べる口を、砂場で確かめる**（#556）。
 *
 * **前の版は、この機械の実物の worktree 一覧で合否を決めていた**
 * （`cwd: REPO_ROOT` で `./task loop:worker:paths` を打っていた）——**別の作業場が
 * worktree を足せば一覧が変わり**、**その `git` が競って落ちれば `status` が非 0 になる。**
 * **`AGENTS.md` §5 / #186 が名指ししている形**である（**合否が他人の持ち物で決まる**）。
 *
 * **実際に `./task check` の中で 1 度赤くなり、単独では緑だった。**
 *
 * **口そのものは変えない。** **実物を見る口は、実物を見てよい**——**変えるのは、
 * どの「実物」を見せるか**である。**砂場に worktree を自分で置く。**
 *
 * **本物のリポジトリの worktree は触らない**（**走っている作業場と競る**。#186）。
 */
describe("作業場を並べる口", () => {
  /** **`listing()` が作った砂場の場所**（**本体の作業場**）。 */
  let sandboxRepo = "";

  /** master と worker が 1 つずつ居る砂場。**worktree は自分で置く。** */
  function listing(): string[] {
    const dir = mkdtempSync(join(tmpdir(), "worker-paths-"));
    sandboxRepo = dir;
    sandboxes.push(dir);
    expect(spawnSync("git", ["init", "--quiet", "-b", "main", dir]).status).toBe(0);
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.email=loop@example.invalid", "-c", "user.name=loop", ...args], {
        cwd: dir,
        encoding: "utf8",
      });
    // **worktree を作るには commit が要る**（未出生のブランチからは作れない）
    expect(git("commit", "--allow-empty", "--quiet", "-m", "seed").status).toBe(0);
    for (const suffix of ["-master", "-worker-b", "-preview"]) {
      const added = `${dir}${suffix}`;
      sandboxes.push(added);
      expect(git("worktree", "add", "--detach", "--quiet", added, "HEAD").status).toBe(0);
    }
    // **口は本物を置く**（#227）——**書き写した身代わりでは、口の振る舞いを測れない**
    const runner = join(dir, "task");
    copyFileSync(join(REPO_ROOT, "task"), runner);
    chmodSync(runner, 0o755);

    const done = spawnSync("./task", ["loop:worker:paths"], { cwd: dir, encoding: "utf8" });

    expect(done.status, done.stderr).toBe(0);
    return done.stdout.trim().split("\n").filter(Boolean);
  }

  it("master の作業場を、worker に数えない", () => {
    // **1 件目の直しと同じ理由**——**master の入口は `--trigger` を渡さない**。
    // **砂場に master を自分で置いてある**ので、**居ないから通る、が起きない。**
    expect(
      listing().filter((path) => path.endsWith("-master")),
      "master を数えている",
    ).toEqual([]);
  });

  it("人が見る画面の作業場も、worker に数えない", () => {
    // **周回を回さない作業場**である (#457)——**混ぜると「止まっている worker」に見える**
    expect(
      listing().filter((path) => path.endsWith("-preview")),
      "preview を数えている",
    ).toEqual([]);
  });

  it("いま登録されている作業場から並べる", () => {
    // **`git worktree list` が正**である（`./task loop:stop-paths` と同じ口）。
    //
    // **両側を見る** (#557 のレビュー 2 周目)。**足した worker だけを見ると、
    // 一覧の 1 件目（clone 本体）を落とす退行が通る**——**本体も worker として
    // 周回する**（**この作業場がまさに本体**）ので、**消えると `bin/loop-cadence` は
    // その停止を検出できない。** **「1 つ以上」から締めた反対側が、そこで緩んでいた。**
    const listed = listing();

    expect(
      listed.filter((path) => path.endsWith("-worker-b")),
      "足した worker が出ない",
    ).toHaveLength(1);
    expect(listed, "本体の作業場が出ない").toContain(sandboxRepo);
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

/**
 * **混ざるものを、元から入れない**（#444）。
 *
 * **捨てて呼び直した周回は、同じ cron の刻みの 2 回目**である——**そこで
 * `--trigger cron` を渡すと、34〜91 秒の間が記録に入り**、**周期として読まれる**
 * （**実測: `interval=~91`。窓が約 3 分になっていた**）。
 *
 * **判定を持つのは `bin/loop-lease` の冒頭である**（#581）。**ここは以前、両方の入口に
 * 同じ文が書いてあることを要求していた**——**写しを強制する試験**だった。
 * **写した結果、決め方が worker の入口にしか根付かず、master 側は時計の推量で
 * 渡していた**（`AGENTS.md` §5）。**入口が指しているかは
 * `loop/trigger-fact-wiring.test.ts` が見る**ので、**ここは持つ側だけを見る。**
 *
 * **語では測らない**（`AGENTS.md` §4）——**`呼び直` は `bin/loop-lease` に 5 行出る**
 * （**exit 3 の説明・積み方の理由・標準エラーの文面**）。
 * **「捨てて呼び直した周回」まで寄せると 1 行**である。
 */
describe("呼び直した周回を、cron として記録しない", () => {
  it("決め方を持つ側が、呼び直しは poke だと書いている", () => {
    const script = readFileSync(join(REPO_ROOT, "bin/loop-lease"), "utf8");

    expect(script, "呼び直しの trigger が書いていない").toMatch(/捨てて呼び直した周回.{0,20}poke/);
  });
});

/**
 * **説明に書いた数が、実装より 2 世代古かった**（#501）。
 *
 * **#497 から #500 まで、4 周かけて分岐を足した**——**足すたびに理由は書き足した**
 * が、**先頭の「原因は 2 つ」だけが置き去りになった**（**利用者の目に触れる
 * `[WARN]` にも同じ数が出ていた**）。
 *
 * **#500 で言語化したもの**（**`if` を足したら、その上に並んでいる `if` を数える**）
 * **の、散文側**である——**分岐を足したら、その分岐を数えている文を数える。**
 *
 * **数は書いてよい。ただし、数える側を置く**——**そうしないと、次に足した人が
 * また置き去りにする**（**散文は、誰も走らせない**）。
 *
 * **数え方は、走らせて数える**（#502 のレビュー）。**文字列で数えると、書き方に
 * 依存する**——**別の場所に例が増えれば赤くなり**、**変数経由で出す分岐を足せば
 * 数に入らない。** **黙るほうが問題である**（**この試験は「足したのに直し忘れる」
 * を捕まえるために在る**）。
 *
 * **`show_reading` を切り出し、入力を全部通して、出た文面の種類を数える**
 * ——**出し方に依存しない**（#500 で順序を測ったときと同じ手）。
 */
describe("暇な枠を跨いだかで、次の一手を決める（#575）", () => {
  /**
   * **`stale` は次の一手を決められなかった**——**`CronList` を引いても、
   * 「空なら入れ直す / 空でなければ塞がっているだけ」で 2 つに割れたまま**である。
   *
   * **割れる理由は「暇な枠を跨いだか」がどこにも残っていないこと**だった
   * ——**塞がっているセッションでは cron が発火しない**ので、
   * **鳴らなかったことは、死んでいる証拠にも、忙しい証拠にもなる。**
   *
   * **周回を握っていた時間なら、記録から言える。**
   */
  it("暇な枠を跨いだのに鳴っていないなら、入れ直すと言う", () => {
    const { dir } = workspace();
    records(dir, [
      [1_000, "cron"],
      [9_000, "poke"],
      [9_500, "poke"],
    ]);
    // **どの周回もすぐ返している**——**枠（1800 秒ごと）のとき、この作業場は暇だった。**
    held(dir, [
      [1_000, 1_100],
      [9_000, 9_100],
      [9_500, 9_600],
    ]);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.stdout, "止まっていると言っていない").toMatch(/stale/);
    expect(done.stdout, "暇な枠を跨いだのに、まだ引けと言っている").toMatch(/暇な枠を/);
    // **「引いて見る」は、判定を人へ差し戻す側の言い方**である——**倒せたなら出ない。**
    // **`CronList` そのものでは見分けない**（**倒した側も「引かずに」と言う**）。
    expect(done.stdout, "引いて見ろ、のままになっている").not.toMatch(/引いて見る/);
  });

  it("暇な枠を跨いでいないなら、判らないと言う", () => {
    // **#531 を壊さない**——**塞がっていただけのことがある。**
    const { dir } = workspace();
    // **枠は 1800 秒ごと**（2800 / 4600 / 6400 / 8200 / 10000）——**そのどれもが、
    // 走っている周回の中にある。**
    records(dir, [
      [1_000, "cron"],
      [2_500, "poke"],
      [5_000, "poke"],
      [7_500, "poke"],
      [9_000, "poke"],
    ]);
    // **枠はどれも、走っている周回の中にある。**
    held(dir, [
      [1_000, 1_500],
      [2_500, 5_000],
      [5_000, 7_000],
      [7_500, 9_000],
      [9_000, 10_000],
    ]);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.stdout, "止まっていると言っていない").toMatch(/stale/);
    expect(done.stdout, "跨いでいないのに断定している").not.toMatch(/入れ直す/);
    expect(done.stdout, "判らないと言っていない").toMatch(/まだ判らない/);
  });

  it("終わりの記録が無いなら、これまでどおり引いて見ろと言う", () => {
    // **読めないことを、片方へ倒さない**——**記録を持たない版から上げた直後がこれ。**
    const { dir } = workspace();
    records(dir, [
      [1_000, "cron"],
      [9_000, "poke"],
    ]);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.stdout, "止まっていると言っていない").toMatch(/stale/);
    // **判定した側の言い方は「暇な枠」で見分ける**——**`入れ直す` は、これまでの
    // 文面（`空なら入れ直す`）にも出る**（**先に数えた**）。
    expect(done.stdout, "記録が無いのに断定している").not.toMatch(/暇な枠/);
    expect(done.stdout, "引く先を言っていない").toMatch(/CronList/);
  });

  it("鳴ったが走れなかった記録は、握っていた時間に数えない", () => {
    // **`cron-blocked` は lease を取れなかった試み**である（#536）——**周回は
    // 始まっていない**ので、**返した記録も無い。** **始まりの数から引く形にすると、
    // これが 1 本あるだけで「ずっと握っている」へ倒れたまま戻らない**
    // （#578 のレビュー。**倒れる先は「まだ判らない」＝黙る側**である）。
    const { dir } = workspace();
    records(dir, [
      [1_000, "cron"],
      [1_200, "cron-blocked"],
      [9_000, "poke"],
    ]);
    held(dir, [
      [1_000, 1_100],
      [9_000, 9_100],
    ]);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    // **`入れ直す` では見分けられない**——**倒せなかったときの文面（`空なら入れ直す`）にも
    // 出る**（**先に数えた**）。**倒した側にしか無い語で見る。**
    expect(done.stdout, "走れなかった記録で、握っていると読んでいる").toMatch(/暇な枠を/);
  });

  it("組の記録より前の枠は、数に入れない", () => {
    // **この記録を持たない版から上げた直後**——**始まりだけが残っている。**
    // **そこを「暇だった」と読まない**（**刈られたぶんも同じ**）。
    //
    // **同時に、その先で止まったままにもしない** (#578 のレビュー)——**古い始まりを
    // 引き算に混ぜると、以後ずっと「握っている」になる。**
    const { dir } = workspace();
    records(dir, [
      [1_000, "cron"],
      [2_000, "poke"],
      [3_000, "poke"],
      [9_000, "poke"],
    ]);
    // **組は、いちばん新しい 1 周ぶんだけ**（**それ以前は分からない**）。
    held(dir, [[9_000, 9_100]]);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    // **9000 より前の枠（2800 / 4600 / 6400 / 8200）は数えない**——**残るのは 10000 だけ**で、
    // **そこは暇だった。**
    expect(done.stdout, "組より前を数えているか、その先で止まったままになっている").toMatch(
      /暇な枠を 1 回跨いだ/,
    );
  });

  it("刈り込みの窓は、始まりと終わりで食い違わない", () => {
    // **別々のファイルに持つと、片方だけが押し出される** (#578 のレビュー)——
    // **組にしてあるので、食い違いようが無い。** **その形をここで留める。**
    const { dir, stamp } = workspace();
    for (let i = 0; i < 25; i += 1) {
      round(dir, stamp, "poke");
    }

    const scope = spawnSync(join(dir, "bin/loop-lease"), ["scope", "worker"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(scope.status, scope.stderr).toBe(0);
    const lines = readFileSync(
      join(dir, ".git", `valence-loop-held-${scope.stdout.trim()}`),
      "utf8",
    )
      .split("\n")
      .filter(Boolean);

    expect(lines.length, "握っていた時間が増え続けている").toBeLessThanOrEqual(20);
    for (const line of lines) {
      expect(line.split("\t"), "始まりと終わりが組になっていない").toHaveLength(2);
    }
  });

  it("返せずに終わった周回があるなら、分からないと言う", () => {
    // **`release` へ到達しない周回がある**（**無音のまま期限切れになって
    // 引き継がれた・context が尽きた・落ちた**）。**組が書かれないので、
    // その周回のぶんだけ履歴に穴が開く**（#578 のレビュー 2 周目）。
    //
    // **穴を「暇だった」と読むと、倒れる向きが逆になる**——**実際には旧 lease が
    // 塞いでいて cron が発火できなかった枠**を、**「死んでいるので入れ直す」**と言う。
    // **従うと予定が 2 本になる。**
    //
    // **開始の一覧は、穴の検出にだけ使う**（**算術には戻さない**。前の 3 件が戻る）。
    const { dir } = workspace();
    records(dir, [
      [1_000, "cron"],
      [2_000, "poke"], // **返していない**——組が無い
      [9_000, "poke"],
    ]);
    held(dir, [
      [1_000, 1_100],
      [9_000, 9_100],
    ]);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    expect(done.stdout, "止まっていると言っていない").toMatch(/stale/);
    expect(done.stdout, "穴を暇だったと読んでいる").not.toMatch(/暇な枠/);
    expect(done.stdout, "分からない側へ倒していない").toMatch(/引いて見る/);
  });

  it("いま回している周回の中の枠は、暇に数えない", () => {
    // **組が書かれるのは返したとき**なので、**走っている最中の周回は記録に無い**
    // ——**その始まりを別に見ないと、いま握っている時間まで「暇だった」になる。**
    const { dir, stamp } = workspace();
    // **先に握る**——**`acquire` は始まりを 1 行足す**ので、**あとから記録を置く**
    // （**置かないと、その 1 行が「どう始まったか分からない周回」として読まれる**）。
    running(dir, stamp, 9_200);
    records(dir, [
      [1_000, "cron"],
      [9_200, "poke"],
    ]);
    held(dir, [[1_000, 1_100]]);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000", LOOP_CRON_INTERVAL_SEC: "1800" });

    // **枠は 2800 / 4600 / 6400 / 8200 / 10000**——**最後の 1 つは、走っている周回の中**である。
    expect(done.stdout, "走っている周回の中の枠を、暇に数えている").toMatch(/暇な枠を 4 回跨いだ/);
  });

  it("実際に返した周回が読める", () => {
    // **両端を留める**——**書く側（`bin/loop-lease`）と読む側（この試験）で
    // 置き場所が食い違うと、ここだけが緑になる。**
    const { dir, stamp } = workspace();
    round(dir, stamp, "cron");
    round(dir, stamp, "poke");

    const scope = spawnSync(join(dir, "bin/loop-lease"), ["scope", "worker"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(scope.status, scope.stderr).toBe(0);
    const written = readFileSync(
      join(dir, ".git", `valence-loop-held-${scope.stdout.trim()}`),
      "utf8",
    );

    expect(
      written.trim().split("\n").filter(Boolean),
      "返した周回の数だけ残っていない",
    ).toHaveLength(2);
  });
});

describe("鳴った記録を、突かれた記録に押し出させない（#575）", () => {
  /**
   * **問題が長引くほど、見張りの声が小さくなっていた**（master の実測、2026-09-02）。
   *
   * **窓は 20 件**で、**cron が鳴らないほど poke が積もる**——**押し出された結果、
   * `cron` の記録が 1 件になり**、**間隔が測れず**（2 件要る）、
   * **判定は `stale` から `unknown` へ落ちた**（**`読み=` ごと消えた**）。
   *
   * **もう 1 周で `last_cron=-` になる**——**「ずっと鳴っていない」と
   * 「一度も鳴っていない」が同じ顔になる**（`AGENTS.md` §5 が名指ししている形）。
   *
   * **#537 は「別の種類の行を足した」ときの話**だったが、**普通の poke が積もるだけで
   * 同じところへ来る。**
   */
  it("突かれた周回が窓を超えても、鳴った記録は残る", () => {
    const { dir, stamp } = workspace();
    round(dir, stamp, "cron");
    round(dir, stamp, "cron");
    // **窓（20 件）を超えるまで突く。**
    for (let i = 0; i < 25; i += 1) {
      round(dir, stamp, "poke");
    }

    const scope = spawnSync(join(dir, "bin/loop-lease"), ["scope", "worker"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(scope.status, scope.stderr).toBe(0);
    const written = readFileSync(
      join(dir, ".git", `valence-loop-starts-${scope.stdout.trim()}`),
      "utf8",
    );
    const cronLines = written.split("\n").filter((line) => line.split("\t")[1] === "cron");

    // **間隔を測るには 2 件要る**——**1 件へ落ちた時点で、判定は黙る。**
    expect(cronLines, "鳴った記録が押し出されている").toHaveLength(2);
  });

  it("突かれた記録は、これまでどおり窓で刈る", () => {
    // **残す側を足したぶん、もう片方が増え続けては意味が無い**（#537）。
    const { dir, stamp } = workspace();
    for (let i = 0; i < 25; i += 1) {
      round(dir, stamp, "poke");
    }

    const scope = spawnSync(join(dir, "bin/loop-lease"), ["scope", "worker"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(scope.status, scope.stderr).toBe(0);
    const written = readFileSync(
      join(dir, ".git", `valence-loop-starts-${scope.stdout.trim()}`),
      "utf8",
    );
    const pokeLines = written.split("\n").filter((line) => line.split("\t")[1] === "poke");

    expect(pokeLines.length, "突かれた記録が増え続けている").toBeLessThanOrEqual(20);
  });

  it("間隔が測れないときも、次に見るところを言う", () => {
    // **`unknown` で黙ると、そこで人が止まる**（#530 と同じ形）——
    // **`stale` のときだけ読みを出していた。**
    const { dir } = workspace();
    records(dir, [
      [1_000, "cron"],
      [9_000, "poke"],
      [9_500, "poke"],
    ]);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000" });

    expect(done.stdout, "間隔が測れると言っている").toMatch(/interval=unknown/);
    expect(done.stdout, "どこを見るかを言っていない").toMatch(/読み=/);
    expect(done.stdout, "どの作業場かを言っていない").toMatch(/workspace=/);
    // **「一度も鳴っていない」と混ぜない**——**鳴った記録は 1 本ある。**
    expect(done.stdout, "一度も鳴っていない側の文面が出ている").not.toMatch(/1 本も無い/);
  });

  it("一度も鳴っていないときは、そう言う", () => {
    // **押し出されたのと混ぜない**（`AGENTS.md` §5）。
    const { dir } = workspace();
    records(dir, [
      [9_000, "poke"],
      [9_500, "poke"],
    ]);

    const done = cadence(dir, { LOOP_CADENCE_NOW: "10000" });

    expect(done.stdout, "鳴った記録があると言っている").toMatch(/last_cron=-/);
    expect(done.stdout, "一度も鳴っていないと言っていない").toMatch(/1 本も無い/);
  });
});

describe("説明の数と、実際に出る読みを突き合わせる（#501 / #502）", () => {
  /** **数を書いている文**（**`原因は予定表が…` のような、数でない行には当たらない**）。 */
  const CLAIM = /原因は\s*(\d+)\s*つ/g;

  /**
   * **説明の側も、その節だけを見る**（#502 のレビュー 2 周目）。
   *
   * **突き合わせは 2 つの側を持つ**——**読みの側を狭めたとき、説明の側は自分の
   * diff に出てこない**（**`AGENTS.md` §5 の「変えた側ではなく残る側を数える」**）。
   *
   * **節は、直前の関数の終わりから `recorded_round` の定義まで**である
   * ——**中身の言葉ではなく、置かれている場所で切る**（**切り方が、数えたい語に
   * 依存しないように**）。
   *
   * **`[WARN]` の側は、ここには入らない**——**あちらには数を書いていない**
   * （**「原因は行ごとに違う」**）。**数を書く場所を 1 つに寄せてある。**
   */
  function explanationOf(script: string): string {
    const end = script.indexOf("recorded_round() {");
    expect(end, "recorded_round が bin/loop-cadence にありません").toBeGreaterThanOrEqual(0);
    const before = script.slice(0, end);
    const start = before.lastIndexOf("\n}\n");
    expect(start, "説明の節の始まりが見つかりません").toBeGreaterThanOrEqual(0);
    return before.slice(start + 3);
  }

  /** **その節に書かれた数**（**書かれていなければ空**）。 */
  function claimsOf(script: string): number[] {
    return [...explanationOf(script).matchAll(CLAIM)].map(([, count]) => Number(count));
  }

  /** **読みを出す側**（`show_reading` が中で呼ぶものも要る）。 */
  const PARTS = ["recorded_round", "fresh_round", "show_reading"] as const;

  /** **その版の `bin/loop-cadence` から、関数をそのまま取り出す。書き写さない。** */
  function shellFunction(script: string, name: string): string {
    const from = script.indexOf(`${name}() {`);
    expect(from, `${name} が bin/loop-cadence にありません`).toBeGreaterThanOrEqual(0);
    return `${script.slice(from).split("\n}\n")[0] ?? ""}\n}\n`;
  }

  /**
   * **走らせて、出た読みの種類を数える。**
   *
   * **入力を全部通す**——**`last_poke` / `last_unknown` は「無い・古い・新しい」の
   * 3 通り、窓は「分かる・分からない」の 2 通り。** **分岐が増えれば、その組み合わせ
   * のどこかで新しい文面が出る**ので、**出し方（`echo` か変数か）に依存しない。**
   */
  /**
   * **ドライバが回す入力軸**——**`show_reading` の位置引数と、順も数も同じ。**
   *
   * **軸が増えたら、ここも増える**（#502 のレビュー 3 周目）。**下の「軸の数が
   * 合っている」が、増やし忘れを赤にする**——**足りないドライバは、新しい分岐へ
   * 一度も入らないまま「4 種類」を数える**（**説明が古いまま緑**になる）。
   */
  const AXES = [
    ["-", "1000", "9500"], // last_poke: 記録が無い / 窓の外 / 窓の中
    ["-", "1000", "9500"], // last_unknown: 同上
    ["", "3600"], // window: 分からない / 分かる
    ["-", "0", "2"], // 暇な枠 (#575): 数えられない / 跨いでいない / 跨いだ
    ["-", "1000"], // last_cron (#575): 一度も鳴っていない / 押し出されて 1 本
  ];

  /** 各軸の値を、すべての組み合わせで並べる。 */
  function combinations(axes: string[][]): string[][] {
    return axes.reduce<string[][]>(
      (rows, values) => rows.flatMap((row) => values.map((value) => [...row, value])),
      [[]],
    );
  }

  function readingsOf(script: string): string[] {
    const driver = [
      "set -u",
      "NOW=10000",
      ...PARTS.map((name) => shellFunction(script, name)),
      ...combinations(AXES).map(
        (values) => `show_reading ${values.map((value) => `"${value}"`).join(" ")}`,
      ),
    ].join("\n");
    const run = spawnSync("/bin/bash", ["-c", driver], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    const lines = run.stdout.split("\n").filter((line) => line.trim().length > 0);
    return [...new Set(lines)];
  }

  /**
   * **`show_reading` が読む位置引数の番号**（`$1` も `${1-}` も拾う）。
   *
   * **範囲は `show_reading` の中だけ**（`AGENTS.md` §4）——**`bin/loop-cadence` 全体では
   * 位置引数を持つ行が 12 行あり**、**そのうち `show_reading` の中は 1 行だけ**である
   * （**`local last_poke="${1-}" last_unknown="${2-}" window="${3-}"`**）。
   *
   * **番号で読んでいない形は、数えられない**——**`$@` / `$*` / `shift` があれば、
   * 何軸なのかはここからは決まらない。** **そのときは「分からない」で落とす**
   * （**「3 軸だ」と読んで、黙って通さない**）。
   */
  function positionalsOf(fn: string): number[] {
    expect(fn, "位置引数を番号で読んでいないので、軸の数が決まりません").not.toMatch(
      /\$[@*]|\bshift\b/,
    );
    const numbers = [...fn.matchAll(/\$\{?([1-9])[0-9]*/g)].map(([, digit]) => Number(digit));
    return [...new Set(numbers)].sort((a, b) => a - b);
  }

  const script = () => readFileSync(join(REPO_ROOT, "bin/loop-cadence"), "utf8");

  it("説明に書いた原因の数が、`show_reading` が出す読みの数と合っている", () => {
    const readings = readingsOf(script());
    const claims = claimsOf(script());

    // **数える側が空になったことを、緑と混ぜない**——**取り出しに失敗すると、
    // 何も見ないまま通る。**
    expect(readings.length, "読みが 1 つも出ていない").toBeGreaterThan(0);
    for (const claim of claims) {
      expect(claim, "説明の数が、出る読みの数と合っていない").toBe(readings.length);
    }
    // **数を書かない形も許す**（#501 の完了条件）——**書かなければ、食い違いようが
    // 無い。** **ただし漢数字は見えない**（「原因は四つ」と書かれたら素通りする）。
    //
    // **数でない文に、数を書かない**——**「原因は 1 つではない」は、数える側からは
    // 「1 つ」に見える**（**この試験を書いている最中に、自分で踏んだ**）。
    // **倒れる向きは安全側**である（**赤くなるので気づく。黙って見逃さない**）。
  });

  it("ドライバが回す軸の数が、`show_reading` の位置引数と合っている", () => {
    // **ここが空くと、この PR の主張が空になる**（#502 のレビュー 3 周目）——
    // **第 4 の軸で決まる読みを足しても、3 軸しか回さないドライバは到達しない**ので、
    // **説明が「4 つ」のままでも緑になる。**
    //
    // **軸を先回りして足さない。** **足りないことが赤くなればよい**——
    // **増やした人が、増やしたときにドライバを直す。**
    const positionals = positionalsOf(shellFunction(script(), "show_reading"));

    // **読めなかったことを、緑と混ぜない。**
    expect(positionals.length, "位置引数を 1 つも読んでいない").toBeGreaterThan(0);
    expect(positionals, "位置引数が飛んでいる（$1 から連番で読んでいない）").toStrictEqual(
      positionals.map((_, index) => index + 1),
    );
    expect(positionals.length, "ドライバの軸の数が、show_reading の引数と合っていない").toBe(
      AXES.length,
    );
  });

  it("説明の節の外に数を書いても、突き合わせに入らない", () => {
    // **前の周回で読みの側を狭めたとき、説明の側は自分の diff に出てこなかった**
    // （#502 のレビュー 2 周目）——**片方を直したら、突き合わせている相手を見る。**
    const decoy = `# **別の話。原因は 2 つある**\n${script()}`;

    expect(claimsOf(decoy), "節の外に書いた数を拾っている").toStrictEqual(claimsOf(script()));
  });

  it("説明の節に数を書けば、突き合わせに出る", () => {
    // **狭めた先が空になっていないこと**——**節の切り方を間違えると、
    // 何も拾わないまま緑になる**（**上の decoy と対で、節の両側を見ている**）。
    //
    // **入力は、いまの本文から作らない** (#502 のレビュー 3 周目)。**数を消すのは、
    // この PR が許している形**（すぐ上の試験）——**実ファイルに `原因は 4 つ` が
    // 在ることを前提にすると、消した瞬間にこの試験が「書き戻せ」と言う**
    // （**この PR が開けた逃げ道を、試験が塞ぎ返す**）。
    //
    // **節の終わりは `recorded_round` の定義**なので、**その直前へ 1 行入れる**
    // ——**いまの本文が数を持っていても、持っていなくても、1 つ増える。**
    const marker = "recorded_round() {";
    const withNumber = script().replace(marker, `# **試験が入れた行。原因は 7 つ**\n${marker}`);
    expect(withNumber, "書き換えが当たっていない").not.toBe(script());

    expect(claimsOf(withNumber), "節の中に入れた数を拾えていない").toStrictEqual([
      ...claimsOf(script()),
      7,
    ]);
  });

  it("`show_reading` の外に同じ書き方の文面があっても、数に入らない", () => {
    // **文字列で数えると、ここで赤くなった**（#502 のレビュー）——**原因は増えて
    // いないのに、例を 1 行足しただけで数が変わる。**
    const decoy = `# 例: echo "  読み=これは説明のための例である"\n${script()}`;

    expect(readingsOf(decoy), "外に置いた例を数えている").toStrictEqual(readingsOf(script()));
  });

  it("`show_reading` の中に違う出し方で足したら、数に入る", () => {
    // **こちらが本当に怖い側**である（#502 のレビュー）——**文字列で数えると、
    // 二重引用符で書かれた文面しか見えない**ので、**単引用符や変数経由で出す分岐を
    // 足しても数が増えず**、**説明が古いまま黙って緑になる。**
    //
    // **最後の 1 行を、別の書き方の新しい文面に差し替える**——**手前の分岐は
    // `$asleep` を出したままなので、読みは 1 種類増える。**
    const added = script().replace(
      '\n  echo "$asleep"\n}',
      "\n  echo '  読み=試験が足した 5 つ目（別の書き方で出している）'\n}",
    );
    expect(added, "書き換えが当たっていない").not.toBe(script());

    expect(readingsOf(added).length, "違う出し方で足した読みが、数から漏れた").toBe(
      readingsOf(script()).length + 1,
    );
  });
});
