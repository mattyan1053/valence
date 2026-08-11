import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { budgetFor } from "../test/slow-machine";

/**
 * 同時に取りに行く数。**枠もここから導く**ので、増やしたら枠も一緒に増える
 * （`budgetFor(CONCURRENT_ACQUIRES + 1)`。+1 は束ねる bash）。
 */
const CONCURRENT_ACQUIRES = 16;

const SCRIPT = fileURLToPath(new URL("./loop-lease", import.meta.url));

type Run = { status: number; stdout: string; stderr: string };

describe("bin/loop-lease", () => {
  let sandbox: string;

  /** **実リポジトリの lease を触らない。** 使い捨ての git リポジトリを cwd にする。 */
  function run(args: string[], env: Record<string, string> = {}): Run {
    const result = spawnSync(SCRIPT, args, {
      cwd: sandbox,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  function acquire(role = "worker", env: Record<string, string> = {}): Run {
    return run(["acquire", role], env);
  }

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "loop-lease-"));
    expect(spawnSync("git", ["init", "--quiet", sandbox]).status).toBe(0);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("取れたら token を出す", () => {
    const held = acquire();

    expect(held.status).toBe(0);
    expect(held.stdout.trim()).toMatch(/^[0-9a-f]{16,}$/);
  });

  it("保持されている間は取れない", () => {
    // **同じ役の周回を 2 つ走らせない。** 同じ作業ツリーで checkout と commit が
    // 並行すると、ブランチを切った直後に戻される（#68 の形）
    expect(acquire().status).toBe(0);
    const second = acquire();

    expect(second.status).toBe(1);
    expect(second.stdout).toBe("");
  });

  it("取れなかったことが分かる", () => {
    // **黙って終わらない。** 通知で促しても動かない状態が観測できなくなる
    expect(acquire().status).toBe(0);

    expect(acquire().stderr).toMatch(/worker/);
  });

  it("役が違えば同時に取れる", () => {
    // master と worker は別の作業ツリーで動く。互いを待たせない
    expect(acquire("worker").status).toBe(0);

    expect(acquire("master").status).toBe(0);
  });

  it("返せば次が取れる", () => {
    const token = acquire().stdout.trim();

    expect(run(["release", "worker", token]).status).toBe(0);
    expect(acquire().status).toBe(0);
  });

  it("他人の token では返せない", () => {
    // **走っている周回の lease を横取りさせない。** 取り違えると直列化が崩れる
    expect(acquire().status).toBe(0);

    const wrong = run(["release", "worker", "0123456789abcdef"]);

    expect(wrong.status).toBe(1);
    expect(acquire().status).toBe(1);
  });

  it("誰も持っていないのに返そうとしたら分かる", () => {
    const orphan = run(["release", "worker", "0123456789abcdef"]);

    expect(orphan.status).toBe(1);
    expect(orphan.stderr).not.toBe("");
  });

  it("期限が切れた lease は引き継げる", () => {
    // **落ちた周回が lease を抱えたままになりうる。** 期限が無いと、
    // その役のループが二度と動かない
    expect(acquire("worker", { LOOP_LEASE_TTL_SEC: "0" }).status).toBe(0);

    expect(acquire("worker", { LOOP_LEASE_TTL_SEC: "0" }).status).toBe(0);
  });

  it("引き継いだことが分かる", () => {
    // 期限切れの引き継ぎは異常の跡である。黙って上書きしない
    expect(acquire("worker", { LOOP_LEASE_TTL_SEC: "0" }).status).toBe(0);

    expect(acquire("worker", { LOOP_LEASE_TTL_SEC: "0" }).stderr).not.toBe("");
  });

  it("引き継がれた側の token では返せない", () => {
    const stale = acquire("worker", { LOOP_LEASE_TTL_SEC: "0" }).stdout.trim();
    acquire("worker", { LOOP_LEASE_TTL_SEC: "0" });

    expect(run(["release", "worker", stale]).status).toBe(1);
  });

  describe("held — 周回が lease を持っているか", () => {
    // **入口は散文の指示のままだった。** 「冒頭で呼べ」と書いてあるだけなので、
    // **呼ばずに進める**——実際に飛ばした（通知で始めた周回で 2 回中 2 回）。
    // **飛ばしても何も起きない**ので、並行したときだけ壊れ、そのときは
    // **「レビュー要求が 2 件」**などの形で出て、原因が入口だと分からない。

    it("持っていれば 0 を返す", () => {
      acquire();

      expect(run(["held", "worker"]).status).toBe(0);
    });

    it("誰も持っていなければ 1 を返す", () => {
      expect(run(["held", "worker"]).status).toBe(1);
    });

    it("返したあとは 1 を返す", () => {
      const token = acquire().stdout.trim();
      run(["release", "worker", token]);

      expect(run(["held", "worker"]).status).toBe(1);
    });

    it("期限が切れていれば 1 を返す", () => {
      // **持っているように見えて、実際は引き継がれる状態**である。
      // ここを 0 にすると、**落ちた周回の跡を「持っている」と読む**
      acquire("worker", { LOOP_LEASE_TTL_SEC: "0" });

      expect(run(["held", "worker"], { LOOP_LEASE_TTL_SEC: "0" }).status).toBe(1);
    });

    it("読むだけで、状態を変えない", () => {
      // **確かめるために奪わない。** `acquire` と違って印も書かない——
      // **見ただけで「新しい周回が始まった」ことにすると、bin/loop-stall の数え方が狂う**
      const token = acquire().stdout.trim();

      expect(run(["held", "worker"]).status).toBe(0);
      expect(run(["release", "worker", token]).status).toBe(0);
    });

    it("役ごとに見る", () => {
      acquire("master");

      expect(run(["held", "master"]).status).toBe(0);
      expect(run(["held", "worker"]).status).toBe(1);
    });
  });

  it("知らない役は受け付けない", () => {
    // **語彙を固定する。** 綴り違いで別の lease を取ると、直列化しているつもりで
    // 2 つ走る
    const unknown = run(["acquire", "workers"]);

    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toMatch(/master/);
  });

  it("使い方を間違えたら 2 で落ちる", () => {
    expect(run([]).status).toBe(2);
    expect(run(["acquire"]).status).toBe(2);
    expect(run(["release", "worker"]).status).toBe(2);
    expect(run(["hold", "worker"]).status).toBe(2);
  });

  it("設定が誤っていたら数えずに落ちる", () => {
    expect(acquire("worker", { LOOP_LEASE_TTL_SEC: "しばらく" }).status).toBe(2);
  });

  it(
    "同時に取りに行っても 1 つしか成功しない",
    () => {
      // **判定と書き込みの間に割り込まれると、両方が「空いている」と読む。**
      // これは `bin/loop-review-budget` で実際に起きる形と同じである。
      // **順に呼んでは意味がない**（保持の検査だけを通ってしまう）ので、
      // シェルの背景ジョブで**本当に同時に**走らせる
      const parallel = spawnSync(
        "bash",
        [
          "-c",
          `for _ in $(seq ${CONCURRENT_ACQUIRES}); do "${SCRIPT}" acquire worker && echo ok & done; wait`,
        ],
        { cwd: sandbox, encoding: "utf8" },
      );

      const acquired = parallel.stdout.split("\n").filter((line) => line === "ok");

      expect(acquired).toHaveLength(1);
    },
    // **この 1 件だけ枠が違う。** bash 1 つと lease を CONCURRENT_ACQUIRES 個、
    // 合わせて 17 プロセスを起こす。**同時に起こしても 1 vCPU では費用は壁時計に乗る**
    // ので、project 全体の枠（10 プロセスぶん）では足りない。
    // **全体を上げない**——上げると、本物の無限ループの検出が遅れるだけになる
    budgetFor(CONCURRENT_ACQUIRES + 1),
  );

  describe("worker はセッションごとに取る", () => {
    /** 同じリポジトリの worktree を足す。**共通ディレクトリを共有する**ので、鍵も共有される。 */
    function addWorktree(name: string): string {
      const dir = join(sandbox, name);
      expect(
        spawnSync("git", ["-C", sandbox, "worktree", "add", "--detach", dir], { encoding: "utf8" })
          .status,
        "worktree を作れない",
      ).toBe(0);
      return dir;
    }

    beforeEach(() => {
      // worktree を足すには commit が 1 つ要る
      spawnSync("git", ["-C", sandbox, "commit", "--allow-empty", "-m", "init"], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@e",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@e",
        },
      });
    });

    function acquireIn(dir: string): Run {
      const result = spawnSync(SCRIPT, ["acquire", "worker"], { cwd: dir, encoding: "utf8" });
      return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
    }

    it("別の作業場からなら、何人でも同時に取れる", () => {
      // **人数を前提にしない。** 「2 人目」を特別扱いすると 3 人目で作り直しになる
      const dirs = [sandbox, addWorktree("second"), addWorktree("third"), addWorktree("fourth")];

      expect(dirs.map((dir) => acquireIn(dir).status)).toEqual([0, 0, 0, 0]);
    });

    it("同じ作業場では 2 つ取れない", () => {
      // **同じ作業場なら直列でなければならない**（checkout と commit が並行する）。
      // 識別子を作業場から作るので、**衝突＝同じ木＝直列**になる
      expect(acquireIn(sandbox).status).toBe(0);

      expect(acquireIn(sandbox).status).toBe(1);
    });

    it("master は作業場が違っても 2 つ取れない", () => {
      // **master は役のまま 1 人。** 判定が並列になるとゲートの意味が薄れる
      const second = addWorktree("second");

      expect(
        spawnSync(SCRIPT, ["acquire", "master"], { cwd: sandbox, encoding: "utf8" }).status,
      ).toBe(0);
      expect(
        spawnSync(SCRIPT, ["acquire", "master"], { cwd: second, encoding: "utf8" }).status,
      ).toBe(1);
    });

    it("取った作業場からは返せる", () => {
      const token = acquireIn(sandbox).stdout.trim();

      const released = spawnSync(SCRIPT, ["release", "worker", token], {
        cwd: sandbox,
        encoding: "utf8",
      });

      expect(released.status).toBe(0);
      expect(acquireIn(sandbox).status).toBe(0);
    });
  });

  describe("長い周回のあいだ、期限切れにしない", () => {
    // **TTL は「周回の長さ」への賭けだった。** 実装する周回は `./task check` を含むので
    // 1 時間近くかかり、**返す前に期限が切れる**（実測で 4 周連続）。切れた窓に
    // 別の周回が入ると、**同じ作業ツリーで checkout と commit が並行する**（#68 の形）。
    //
    // **測るものを変える。** 「取得からの経過」ではなく「**最後に何かが起きてからの経過**」。
    // 長い処理（`./task`）が動いているあいだは活動が続くので、**周回が何分かかっても
    // 切れない**。**止まっていれば、いままでどおり引き継ぐ。**

    /** lease の記録（token と取得時刻）。**名前の作り方は試験に写さない。** */
    function stateFile(): string {
      const dir = join(sandbox, ".git");
      const name = readdirSync(dir).find(
        (entry) => entry.startsWith("valence-loop-lease-worker") && !entry.endsWith(".lock"),
      );
      expect(name, "lease の記録が見つからない").toBeDefined();
      return join(dir, name ?? "");
    }

    /** 活動の記録の名前。**作り方は試験に写さない。** */
    function activityName(): string {
      const name = readdirSync(join(sandbox, ".git")).find(
        (entry) => entry.startsWith("valence-loop-activity-") && !entry.endsWith(".tmp"),
      );
      expect(name, "活動の記録が見つからない").toBeDefined();
      return name ?? "";
    }

    /** lease の記録から作業場ぶんの識別子を取る。**名前の作り方は試験に写さない。** */
    function activityScope(): string {
      return stateFile().replace(/^.*valence-loop-lease-/, "");
    }

    /** 取得時刻を過去へずらす。**待たずに古い状態を作る**（#131 の教訓）。 */
    function ageLease(secondsAgo: number): void {
      const file = stateFile();
      const token = (readFileSync(file, "utf8").split("\t")[0] ?? "").trim();
      writeFileSync(file, `${token}\t${Math.floor(Date.now() / 1000) - secondsAgo}\n`);
    }

    it("活動が続いていれば、取得から TTL を過ぎても引き継がない", () => {
      // **これが本題。** 周回が長いだけで lease を奪われてはいけない
      expect(acquire().status).toBe(0);
      ageLease(3600);

      expect(run(["heartbeat", "worker"]).status).toBe(0);
      const second = acquire();

      expect(second.status).toBe(1);
      expect(second.stderr).not.toContain("引き継ぎます");
    });

    it("活動が止まって TTL を過ぎたら、いままでどおり引き継ぐ", () => {
      // **落ちた周回の lease が永遠に残ってはいけない**（引き継ぎが要る理由）
      expect(acquire().status).toBe(0);
      ageLease(3600);

      const second = acquire();

      expect(second.status).toBe(0);
      expect(second.stderr).toContain("引き継ぎます");
    });

    it("活動の記録が古ければ、記録があっても引き継ぐ", () => {
      // **「記録がある」と「最近だった」は別である。** ファイルの有無で見ると、
      // **落ちた周回の古い記録が lease を永遠に生かす**
      expect(acquire().status).toBe(0);
      ageLease(3600);
      writeFileSync(
        join(sandbox, ".git", `valence-loop-activity-${activityScope()}`),
        `${Math.floor(Date.now() / 1000) - 3600}\n`,
      );

      const second = acquire();

      expect(second.status).toBe(0);
      expect(second.stderr).toContain("引き継ぎます");
    });

    it("取れないとき、走っているのか返し忘れなのかが読める", () => {
      // **手順書は「何周も取れないなら返し忘れ」と読ませる。** 期限切れが常態だと
      // その判断ができない。**最後の活動からの経過**を出せば、その場で分かる
      expect(acquire().status).toBe(0);
      expect(run(["heartbeat", "worker"]).status).toBe(0);

      const second = acquire();

      expect(second.status).toBe(1);
      expect(second.stderr).toMatch(/最後の活動/);
    });

    it("heartbeat は lease を持っていなくても成功する", () => {
      // **`./task` から毎回呼ぶ。** 持っていないときに落ちると、
      // **ループと関係のないコマンドまで失敗する**
      const beat = run(["heartbeat", "worker"]);

      expect(beat.status).toBe(0);
    });

    it("heartbeat は別の役の lease を延命しない", () => {
      // 役が違えば別の周回である。**worker の活動で master の落ちた周回を生かさない**
      expect(run(["acquire", "master"]).status).toBe(0);
      const master = readdirSync(join(sandbox, ".git")).find(
        (entry) => entry === "valence-loop-lease-master",
      );
      expect(master).toBeDefined();
      writeFileSync(
        join(sandbox, ".git", master ?? ""),
        `deadbeefdeadbeef\t${Math.floor(Date.now() / 1000) - 3600}\n`,
      );

      expect(run(["heartbeat", "worker"]).status).toBe(0);
      const retaken = run(["acquire", "master"]);

      expect(retaken.status).toBe(0);
      expect(retaken.stderr).toContain("引き継ぎます");
    });

    it("周回の印は、返しても消えない", () => {
      // **「いま持っているか」ではなく「新しい周回を始めたか」を外から見るための印。**
      // lease と同じ寿命にすると、**周回と周回の間が「始めていない」と同じ見え方**になり、
      // 空転の判定（bin/loop-stall）が**何周まわしても数えられなくなる**（実際に踏んだ）
      const token = acquire().stdout.trim();
      const rounds = () =>
        readdirSync(join(sandbox, ".git")).filter((entry) =>
          entry.startsWith("valence-loop-rounds-worker"),
        );

      expect(rounds()).toHaveLength(1);
      const started = readFileSync(join(sandbox, ".git", rounds()[0] ?? ""), "utf8").trim();

      expect(run(["release", "worker", token]).status).toBe(0);

      expect(rounds()).toHaveLength(1);
      expect(readFileSync(join(sandbox, ".git", rounds()[0] ?? ""), "utf8").trim()).toBe(started);
    });

    it("取り直すと印が変わる", () => {
      // **1 周ごとに 1 回だけ数えられるように、周回ごとに違う値**でなければならない
      const first = acquire().stdout.trim();
      const name = readdirSync(join(sandbox, ".git")).find((entry) =>
        entry.startsWith("valence-loop-rounds-worker"),
      );
      const before = readFileSync(join(sandbox, ".git", name ?? ""), "utf8").trim();
      expect(run(["release", "worker", first]).status).toBe(0);
      // **待たずに作る。** 取得時刻を過去へずらしてから取り直す
      writeFileSync(join(sandbox, ".git", name ?? ""), `${Number(before) - 600}\n`);

      expect(acquire().status).toBe(0);

      expect(readFileSync(join(sandbox, ".git", name ?? ""), "utf8").trim()).not.toBe(
        `${Number(before) - 600}`,
      );
    });

    it("返すときに、いちばん長かった周回を残す", () => {
      // **窓を実測から決めるため**（bin/loop-stall）。書き写した閾値だと、
      // **1 周が長い機械で周回の途中に止められる**
      const token = acquire().stdout.trim();
      const scope = readdirSync(join(sandbox, ".git")).find((entry) =>
        entry.startsWith("valence-loop-rounds-worker"),
      );
      // **待たずに長い周回を作る。** 取得時刻を過去へずらす
      const lease = join(sandbox, ".git", (scope ?? "").replace("rounds", "lease"));
      writeFileSync(lease, `${token}\t${Math.floor(Date.now() / 1000) - 300}\n`);

      expect(run(["release", "worker", token]).status).toBe(0);

      const lengths = readdirSync(join(sandbox, ".git")).filter((entry) =>
        entry.startsWith("valence-loop-roundlen-worker"),
      );
      expect(lengths).toHaveLength(1);
      const seconds = Number(readFileSync(join(sandbox, ".git", lengths[0] ?? ""), "utf8").trim());

      expect(seconds).toBeGreaterThanOrEqual(300);
    });

    it("短い周回で、いちばん長かった記録を上書きしない", () => {
      // **短いほうで上書きすると、窓が縮んで長い周回の途中で止められる**
      const first = acquire().stdout.trim();
      const rounds = readdirSync(join(sandbox, ".git")).find((entry) =>
        entry.startsWith("valence-loop-rounds-worker"),
      );
      const lease = join(sandbox, ".git", (rounds ?? "").replace("rounds", "lease"));
      writeFileSync(lease, `${first}\t${Math.floor(Date.now() / 1000) - 300}\n`);
      expect(run(["release", "worker", first]).status).toBe(0);

      // 2 周目は一瞬で終わる
      const second = acquire().stdout.trim();
      expect(run(["release", "worker", second]).status).toBe(0);

      const longest = readdirSync(join(sandbox, ".git")).find((entry) =>
        entry.startsWith("valence-loop-roundlen-worker"),
      );
      const seconds = Number(readFileSync(join(sandbox, ".git", longest ?? ""), "utf8").trim());

      expect(seconds).toBeGreaterThanOrEqual(300);
    });

    it("書けなければ、黙って成功しない", () => {
      // **書けていないのに成功を返すと、周回は延命できたつもりで走り続ける。**
      // 期限が切れれば別の周回が入るので、**気づけるのは事故が起きたときだけ**になる
      const dir = join(sandbox, ".git");
      chmodSync(dir, 0o555);
      const beat = run(["heartbeat", "worker"]);
      chmodSync(dir, 0o755);

      expect(beat.status).not.toBe(0);
      expect(beat.stderr).toContain("活動を記録できません");
    });

    it("記録は切り詰めではなく差し替えで置く", () => {
      // **`>` は切り詰めてから書く。** その隙間を `acquire` が読むと、
      // **活動中なのに「記録なし」**として引き継がれる。
      //
      // **競り自体は試験にしない。** 隙間に読ませる試験は時間に依存し、
      // #131 で直したばかりの形を作り直すことになる。**代わりに機構を見る**——
      // 差し替え（rename）なら **inode が変わる**。切り詰めなら変わらない
      expect(run(["heartbeat", "worker"]).status).toBe(0);
      const file = join(sandbox, ".git", activityName());
      const first = statSync(file).ino;

      expect(run(["heartbeat", "worker"]).status).toBe(0);

      expect(statSync(file).ino, "切り詰めて書いている（差し替えになっていない）").not.toBe(first);
    });

    it("置き換えたあとに一時ファイルを残さない", () => {
      expect(run(["heartbeat", "worker"]).status).toBe(0);

      const leftovers = readdirSync(join(sandbox, ".git")).filter(
        (entry) => entry.startsWith("valence-loop-activity-") && entry.endsWith(".tmp"),
      );

      expect(leftovers).toEqual([]);
    });

    it("./task は活動を記録する", () => {
      // **書き忘れる経路を作らない。** 長い処理はすべて `./task` を通るので、
      // **そこが打てば、周回のどこで止まっていても活動が続く**。
      // 手順書に「ここで打つこと」と書く形にすると、**書き忘れがそのまま穴**になる
      const repo = mkdtempSync(join(tmpdir(), "loop-lease-task-"));
      expect(spawnSync("git", ["init", "--quiet", repo]).status).toBe(0);
      mkdirSync(join(repo, "bin"));
      copyFileSync(fileURLToPath(new URL("../task", import.meta.url)), join(repo, "task"));
      copyFileSync(SCRIPT, join(repo, "bin", "loop-lease"));
      chmodSync(join(repo, "task"), 0o755);
      chmodSync(join(repo, "bin", "loop-lease"), 0o755);

      // docker を使わないコマンドで確かめる（help は自分自身を読んで出すだけ）
      expect(spawnSync("./task", ["help"], { cwd: repo, encoding: "utf8" }).status).toBe(0);

      const activity = readdirSync(join(repo, ".git")).filter((entry) =>
        entry.startsWith("valence-loop-activity-"),
      );
      rmSync(repo, { recursive: true, force: true });

      expect(activity).toHaveLength(1);
    });
  });
});
