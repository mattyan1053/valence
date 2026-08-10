import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

  it("同時に取りに行っても 1 つしか成功しない", () => {
    // **判定と書き込みの間に割り込まれると、両方が「空いている」と読む。**
    // これは `bin/loop-review-budget` で実際に起きる形と同じである。
    // **順に呼んでは意味がない**（保持の検査だけを通ってしまう）ので、
    // シェルの背景ジョブで**本当に同時に**走らせる
    const parallel = spawnSync(
      "bash",
      ["-c", `for _ in $(seq 16); do "${SCRIPT}" acquire worker && echo ok & done; wait`],
      { cwd: sandbox, encoding: "utf8" },
    );

    const acquired = parallel.stdout.split("\n").filter((line) => line === "ok");

    expect(acquired).toHaveLength(1);
  });

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
});
