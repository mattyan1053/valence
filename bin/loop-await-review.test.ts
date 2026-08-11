import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-await-review", import.meta.url));

type Run = { status: number; stdout: string; stderr: string };

describe("bin/loop-await-review", () => {
  let sandbox: string;

  /**
   * **本物の `gh` を呼ばない。** 見たいのは「返るまで待つか、上限で諦めるか」であって、
   * レビューの読み取り方ではない（それは `bin/loop-review-commits` のテストが固定している）。
   * スクリプトは `$(dirname "$0")/loop-review-commits` を呼ぶので、
   * **コピーの隣に偽物を置く**と、そちらが動く。
   */
  function withReviews(...responses: string[]): void {
    withSlowReviews(0, ...responses);
  }

  /** 1 回の呼び出しに `delaySec` 秒かかる偽物。**実時間で切れるか**を試すために使う。 */
  function withSlowReviews(delaySec: number, ...responses: string[]): void {
    copyFileSync(SCRIPT, join(sandbox, "loop-await-review"));
    chmodSync(join(sandbox, "loop-await-review"), 0o755);

    // 呼ばれるたびに次の応答へ進む。**「待っていたら出た」を作るため**である。
    const script = [
      "#!/usr/bin/env bash",
      delaySec > 0 ? `sleep ${delaySec}` : ":",
      `count_file="${join(sandbox, "count")}"`,
      'count="$(cat "$count_file" 2>/dev/null || echo 0)"',
      'echo $((count + 1)) > "$count_file"',
      "case $count in",
      // **`%b` で出す。** `%s` だと `\t` がリテラルのまま出て、
      // 時刻の列が壊れたまま「新しい」と読まれる（実際に踏んだ）
      ...responses.map((response, index) => `${index}) printf '%b' ${JSON.stringify(response)};;`),
      `*) printf '%b' ${JSON.stringify(responses.at(-1) ?? "")};;`,
      "esac",
    ].join("\n");
    writeFileSync(join(sandbox, "loop-review-commits"), `${script}\n`, { mode: 0o755 });
  }

  function run(args: string[], env: Record<string, string> = {}): Run {
    const result = spawnSync(join(sandbox, "loop-await-review"), args, {
      cwd: sandbox,
      encoding: "utf8",
      // **実時間の上限は `spawnSync` 自身に持たせる。** vitest のタイムアウトでは
      // 同期呼び出しを中断できないので、**締切を引き伸ばす変異が測れない**。
      // kill されると `status` は null になり、下の `?? -1` で status を見る
      // テストがそのまま落ちる。`MAX_SEC=2` の正常実行が偶然当たらない幅を取る
      timeout: 10_000,
      env: {
        // **`process.env` を土台にする。** 一から組むと `ProcessEnv` の必須項目
        // （`NODE_ENV`）が欠けて型検査が落ちる。**PATH は後から上書きするので絞れている**
        ...process.env,
        PATH: join(sandbox, "path"),
        LOOP_AWAIT_REVIEW_MAX_SEC: "2",
        LOOP_AWAIT_REVIEW_INTERVAL_SEC: "1",
        ...env,
      },
    });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "loop-await-"));
    // **PATH を絞る。** 偽物を置き忘れても本物へ落ちないようにする
    const path = join(sandbox, "path");
    spawnSync("mkdir", ["-p", path]);
    // **git を通す。** 待つあいだに `bin/loop-lease heartbeat master` を打つので、
    // git の共通ディレクトリを引けないと記録できない
    expect(spawnSync("git", ["init", "--quiet", sandbox]).status).toBe(0);
    for (const command of [
      "bash",
      "sleep",
      "date",
      "dirname",
      "cat",
      "tail",
      "cut",
      "git",
      "mv",
      "rm",
    ]) {
      const source = spawnSync("which", [command], { encoding: "utf8" }).stdout.trim();
      if (source !== "") {
        symlinkSync(source, join(path, command));
      }
    }
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("待っているあいだ、master の活動を記録する", () => {
    // **master の周回は、この待ちに時間の大半を使う**（8 分の待ちが 2 回）。
    // ここで打たないと、**待っている最中に lease の期限が切れ**、別の master が
    // 引き継いでレビュー要求とマージ判定が並行する。
    // **打つ場所は「長い区間の直前」だけ**——増やすと書き忘れる経路が戻るので、
    // 長い区間はここと `./task` の 2 つに限る（どちらも試験で押さえてある）
    copyFileSync(
      fileURLToPath(new URL("./loop-lease", import.meta.url)),
      join(sandbox, "loop-lease"),
    );
    chmodSync(join(sandbox, "loop-lease"), 0o755);
    withReviews("");

    expect(run(["74", ""]).status).toBe(1);

    const activity = readdirSync(join(sandbox, ".git")).filter((entry) =>
      entry.startsWith("valence-loop-activity-"),
    );

    expect(activity).toEqual(["valence-loop-activity-master"]);
  });

  it("新しいレビューが返ったら 0 で終わる", () => {
    withReviews(
      "2026-08-10T07:00:00Z\tabc123\n",
      "2026-08-10T07:00:00Z\tabc123\n2026-08-10T07:05:00Z\tdef456\n",
    );

    expect(run(["74", "2026-08-10T07:00:00Z"]).status).toBe(0);
  });

  it("待っている間に返ったものも拾う", () => {
    // **1 回見て終わりにしない。** それでは周回で確認するのと変わらない
    withReviews("", "", "2026-08-10T07:05:00Z\tdef456\n");

    expect(run(["74", ""], { LOOP_AWAIT_REVIEW_MAX_SEC: "5" }).status).toBe(0);
  });

  it("基準より新しくなければ待ち続ける", () => {
    // 前回のレビューが残っているだけの状態を「返った」と誤らない
    withReviews("2026-08-10T07:00:00Z\tabc123\n");

    expect(run(["74", "2026-08-10T07:00:00Z"]).status).toBe(1);
  });

  it("上限に達したら 1 で抜ける", () => {
    // **返らないまま延々ブロックしない。** 次の周回で予算の判定に委ねる
    withReviews("");

    const timedOut = run(["74", "2026-08-10T07:00:00Z"]);

    expect(timedOut.status).toBe(1);
    // **何秒待って諦めたのかを出す。** 出さないと、返らない状態が観測できない
    expect(timedOut.stderr).toMatch(/#74/);
    expect(timedOut.stderr).toMatch(/2 秒/);
  });

  it("待つ前に一度は見る", () => {
    // 既に返っているなら、待たずに終わる（上限 0 でも 0 で返る）
    withReviews("2026-08-10T07:05:00Z\tdef456\n");

    expect(run(["74", "2026-08-10T07:00:00Z"], { LOOP_AWAIT_REVIEW_MAX_SEC: "0" }).status).toBe(0);
  });

  it("間隔を空けて見に行く", () => {
    // **忙しく回さない。** 待っている間はトークンを使わないのが利点なので、
    // 呼び出しを詰めても得は無い
    withReviews("", "2026-08-10T07:05:00Z\tdef456\n");

    const started = Date.now();
    expect(
      run(["74", ""], { LOOP_AWAIT_REVIEW_INTERVAL_SEC: "2", LOOP_AWAIT_REVIEW_MAX_SEC: "9" })
        .status,
    ).toBe(0);

    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
  });

  it("レビューを読めなかったら 2 で落ちる", () => {
    // **判定不能を「返った」に倒さない。** 倒すと、見ていない PR をマージしうる
    copyFileSync(SCRIPT, join(sandbox, "loop-await-review"));
    chmodSync(join(sandbox, "loop-await-review"), 0o755);
    writeFileSync(join(sandbox, "loop-review-commits"), "#!/usr/bin/env bash\nexit 2\n", {
      mode: 0o755,
    });

    expect(run(["74", ""]).status).toBe(2);
  });

  it("使い方を間違えたら 2 で落ちる", () => {
    withReviews("");

    expect(run([]).status).toBe(2);
    expect(run(["74"]).status).toBe(2);
    expect(run(["七四", ""]).status).toBe(2);
  });

  it("設定が誤っていたら待たずに落ちる", () => {
    withReviews("");

    expect(run(["74", ""], { LOOP_AWAIT_REVIEW_MAX_SEC: "しばらく" }).status).toBe(2);
    expect(run(["74", ""], { LOOP_AWAIT_REVIEW_INTERVAL_SEC: "0" }).status).toBe(2);
  });

  it("実時間で締め切る", () => {
    // **`sleep` の秒数だけ数えると、API が遅いときに上限を守れない。**
    // 「ツール呼び出しの制限より短く」という目的が果たせなくなる
    withSlowReviews(2, "");

    const started = Date.now();
    const timedOut = run(["74", "2026-08-10T07:00:00Z"], {
      LOOP_AWAIT_REVIEW_MAX_SEC: "2",
      LOOP_AWAIT_REVIEW_INTERVAL_SEC: "1",
    });

    expect(timedOut.status).toBe(1);
    // 確認 1 回（2 秒）で締切に届く。`sleep` の秒数だけ数える形に戻すと、
    // 確認の時間が入らないぶん **3 回確認して 8 秒** かかる
    expect(Date.now() - started).toBeLessThan(5000);
  }, 15000);

  it("上限が間隔より短ければ、残りだけ待つ", () => {
    // **超過して待たない。** 待ってから諦めると、上限の意味が無くなる
    withReviews("");

    const started = Date.now();
    const timedOut = run(["74", "2026-08-10T07:00:00Z"], {
      LOOP_AWAIT_REVIEW_MAX_SEC: "1",
      LOOP_AWAIT_REVIEW_INTERVAL_SEC: "9",
    });

    expect(timedOut.status).toBe(1);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
