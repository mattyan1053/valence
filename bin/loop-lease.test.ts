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

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
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

  /** **ディスクの手順書の印。** `acquire` が受け取る (#243 のレビュー)。 */
  function stampFor(role: string): string {
    const result = spawnSync(join(REPO_ROOT, "bin/loop-procedure-stamp"), [role], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  }

  function acquire(role = "worker", env: Record<string, string> = {}): Run {
    return run(["acquire", role, stampFor(role)], env);
  }

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "loop-lease-"));
    expect(spawnSync("git", ["init", "--quiet", sandbox]).status).toBe(0);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  describe("busy", () => {
    /**
     * **どこかの作業場で worker の周回が走っているか。**
     *
     * **役ごとの `held` では答えられない。** worker の単位は**作業場**なので、
     * `held worker` は**呼んだ場所の worker** しか見ない——**master の worktree から
     * 尋ねると、worker の lease は見えない**（別の scope になる）。
     *
     * **push から PR 作成までの窓**を、これで見分ける（#148）。**時間で切らない**
     * ——**遅い周回と落ちた周回は、経過時間では分けられない**（#129）。
     */
    it("誰も持っていなければ、走っていないと答える", () => {
      expect(run(["busy", "worker"]).status).toBe(1);
    });

    it("この作業場が持っていれば、走っていると答える", () => {
      expect(acquire().status).toBe(0);

      expect(run(["busy", "worker"]).status).toBe(0);
    });

    it("別の作業場の worker でも見える", () => {
      // **ここが `held` との違いである。** master の worktree から尋ねても、
      // **worker が走っていることが分かる**——**見えないと、PR がまだ無い
      // ブランチを「宙に浮いている」と誤って報告する**
      const now = Math.floor(Date.now() / 1000);
      writeFileSync(
        join(sandbox, ".git", "valence-loop-lease-worker_somewhere_else"),
        `deadbeef\t${now}\np:1:1\n/somewhere/else\n`,
      );

      const busy = run(["busy", "worker"]);

      expect(busy.status).toBe(0);
      expect(busy.stdout, "どの作業場かが出ていない").toContain("/somewhere/else");
    });

    it("期限切れの lease は、走っているとは言わない", () => {
      // **落ちた周回の跡**である。**引き継げる状態を「走っている」と読むと、
      // 宙に浮いたブランチが永久に報告されない**
      const old = Math.floor(Date.now() / 1000) - 4000;
      writeFileSync(
        join(sandbox, ".git", "valence-loop-lease-worker_somewhere_else"),
        `deadbeef\t${old}\np:1:1\n`,
      );

      expect(run(["busy", "worker"], { LOOP_LEASE_TTL_SEC: "60" }).status).toBe(1);
    });

    it("走っている作業場を出す", () => {
      // **「走っているか」だけでは、抑止をブランチ単位にできない**（#148 のレビュー）。
      // **どこか 1 つでも走っていれば全部隠す**と、**worker が途切れず動く環境では
      // 紛失した作業が永久に見つからない**——**動いているほど見つからない**。
      expect(acquire().status).toBe(0);

      const busy = run(["busy", "worker"]);

      expect(busy.status).toBe(0);
      expect(busy.stdout.trim(), "作業場が出ていない").toBe(sandbox);
    });

    it("作業場の入っていない lease は、走っているとも言わない", () => {
      // **「走っている」と答えながら内訳を出さないのは、契約の外**である（#148 のレビュー）。
      // **呼ぶ側は空行を飛ばす**ので、**「走っているが抑えるものは無い」と読み**、
      // **走っている worker のブランチを「宙に浮いている」と誤報する**。
      //
      // **前の版が書いた lease（3 行）で必ず踏む**——**lease のファイルは版をまたいで
      // 共有される**（2 行 → 3 行のときに実際に踏ませた）。**同じところで 2 度落ちない**
      const now = Math.floor(Date.now() / 1000);
      writeFileSync(
        join(sandbox, ".git", "valence-loop-lease-worker_old_version"),
        `deadbeef\t${now}\np:1:1\n`,
      );

      expect(run(["busy", "worker"]).status).toBe(2);
    });

    it("読めなければ、走っていないとは言わない", () => {
      // **契約に `exit 2 = 読めない` と書いてある**（**書いた意図と実装を食い違わせない**）。
      // **「走っていない」に倒すと、作業中のブランチを宙に浮いていると誤報する**
      writeFileSync(join(sandbox, ".git", "valence-loop-lease-worker_broken"), "こわれている\n");

      expect(run(["busy", "worker"]).status).toBe(2);
    });

    it("master は役のまま 1 つなので、そちらも見られる", () => {
      expect(acquire("master").status).toBe(0);

      expect(run(["busy", "master"]).status).toBe(0);
      expect(run(["busy", "worker"]).status).toBe(1);
    });
  });

  /**
   * **配られた手順書が古いことに、入口で気づく** (#241 / #243 のレビュー)。
   *
   * **検査を、検査したい対象の中に置いてはいけない**——**古い版の本文には
   * 「印を突き合わせよ」という行が無い**ので、**手順書に書いた検査は、古い版が
   * 配られた周回では一度も走らない。** **`acquire` はどの版にも冒頭にあり、
   * しかもスクリプト**なので、**ここで要求すれば古い版は落ちる。**
   */
  describe("手順書の印を入口で受ける", () => {
    it("旧版と同じ呼び方（印を渡さない）では取れない", () => {
      // **これが本題。** **印を渡さないまま素通りできない**
      const old = run(["acquire", "worker"]);

      expect(old.status, "印を渡さずに取れてしまう").toBe(2);
      expect(old.stdout, "取れたことにしている").toBe("");
    });

    it("違う印なら取れない（配られたテキストが古い）", () => {
      const stale = run(["acquire", "worker", "0123456789ab"]);

      expect(stale.status).toBe(2);
      expect(stale.stderr, "捨てて呼び直す先が書いていない").toMatch(/procedure-stale/);
    });

    it("同じ印なら、これまでどおり取れる", () => {
      // **止めすぎていないこと**（正常な周回で鳴らない）
      expect(run(["acquire", "worker", stampFor("worker")]).status).toBe(0);
    });
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

  describe("check の案内は、そのまま貼れる", () => {
    // **踏むのはいちばん困っているとき**である（**入口を飛ばした周回**）。
    // **場所取り (`<役>`) をそのまま出すと、bash がリダイレクトとして読み、
    // `loop-lease` 自体が走らない**——**usage で落ちるより分かりにくい** (#257 のレビュー)。
    //
    // **表示された文字列を、置き換えずに bash へ通す。** **argv へ組み立て直すと、
    // 「貼れない」が検査の外に出る**——**前の版はそこを隠していた。**

    /** 案内に出てくる行を、表示されたまま取り出す。 */
    function suggested(stderr: string): string[] {
      const lines = stderr
        .split("\n")
        .map((row) => row.trim())
        .filter((row) => row.startsWith("bin/loop-lease acquire"));
      expect(lines.length, `案内が出ていない: ${stderr}`).toBeGreaterThan(0);
      return lines;
    }

    /** **貼る。** cwd は使い捨てのリポジトリで、スクリプトは実物を指す。 */
    function paste(line: string): Run {
      const result = spawnSync("bash", ["-c", line.replace(/^bin\/loop-lease/, SCRIPT)], {
        cwd: sandbox,
        encoding: "utf8",
        env: { ...process.env },
      });
      return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
    }

    it("貼っても構文で壊れない", () => {
      // **`<役>` を出していた版はここで落ちる**（`syntax error near unexpected token`）
      for (const line of suggested(run(["check"]).stderr)) {
        const pasted = paste(line);

        expect(pasted.stderr, `貼ると壊れる: ${line}`).not.toMatch(/syntax error/);
        // **走らなかったときの bash の終了コード。** **走った上での 1 や 2 とは別**
        expect(pasted.status, `走っていない: ${line}`).not.toBe(2);
      }
    });

    it("貼れば取り直せる", () => {
      // **「壊れない」だけでは足りない。** **usage で終わる案内も壊れてはいない**
      // ——**この周回が本当に lease を取れるところまで見る。**
      const lines = suggested(run(["check"]).stderr);
      const worker = lines.find((line) => line.includes(" worker "));
      expect(worker, "worker の行が無い").toBeDefined();

      const pasted = paste(worker as string);

      expect(pasted.status, `取り直せない: ${pasted.stderr}`).toBe(0);
      expect(pasted.stdout.trim(), "token が返っていない").not.toBe("");
    });

    it("役の両方を出す（ここでは役が分からない）", () => {
      // **この検査は役を受け取らない。** **片方だけ出すと、もう片方の周回は
      // 自分で組み立てることになる**——**その組み立てが、いま直している当のもの**
      const lines = suggested(run(["check"]).stderr);

      expect(lines.some((line) => line.includes(" worker "))).toBe(true);
      expect(lines.some((line) => line.includes(" master "))).toBe(true);
    });
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
    const unknown = run(["acquire", "workers", stampFor("worker")]);

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
          `for _ in $(seq ${CONCURRENT_ACQUIRES}); do "${SCRIPT}" acquire worker ${stampFor("worker")} && echo ok & done; wait`,
        ],
        { cwd: sandbox, encoding: "utf8" },
      );

      const acquired = parallel.stdout.split("\n").filter((line) => line === "ok");

      expect(acquired).toHaveLength(1);
    },
    // **この 1 件だけ枠が違う。** bash 1 つと lease を CONCURRENT_ACQUIRES 個、
    // 合わせて `CONCURRENT_ACQUIRES + 1` プロセスを起こす。**同時に起こしても
    // 1 vCPU では費用は壁時計に乗る**ので、project 全体の枠
    // （`test/slow-machine.ts` の `MODELLED_SPAWNS` ぶん）では足りない。
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
      const result = spawnSync(SCRIPT, ["acquire", "worker", stampFor("worker")], {
        cwd: dir,
        encoding: "utf8",
      });
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
        spawnSync(SCRIPT, ["acquire", "master", stampFor("master")], {
          cwd: sandbox,
          encoding: "utf8",
        }).status,
      ).toBe(0);
      expect(
        spawnSync(SCRIPT, ["acquire", "master", stampFor("master")], {
          cwd: second,
          encoding: "utf8",
        }).status,
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

  describe("記録の名前を、作業場の長さに依存させない", () => {
    // **パス全体を 1 つのファイル名成分へ畳んでいた**ので、**深い checkout では
    // NAME_MAX（一般に 255 バイト）を超え、acquire が常に exit 2 になる**——
    // **worker がまったく動けなくなる**（約 350 文字のパスで再現済み。#98）。
    //
    // **いまの置き場所では踏まない**（`~/valence` で 53 文字）。**踏まないのは
    // 置き場所がたまたま浅いからで、設計上の保証ではない**——**人が別の場所へ
    // clone した瞬間に踏む**。

    /**
     * NAME_MAX を超える長さの作業場を**実際に作る**。
     * **長さの計算だけで済ませない**（#99 の完了条件）——**畳んだ名前が
     * ファイルシステムに拒まれること自体**が、この Issue の中身である。
     */
    function deepWorkspace(): string {
      let dir = sandbox;
      while (dir.length <= 260) {
        dir = join(dir, "a".repeat(40));
      }
      mkdirSync(dir, { recursive: true });
      expect(spawnSync("git", ["init", "--quiet", dir]).status, "git init できない").toBe(0);
      return dir;
    }

    function runIn(dir: string, args: string[]): Run {
      const result = spawnSync(SCRIPT, args, { cwd: dir, encoding: "utf8" });
      return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
    }

    /** lease の記録。**名前の作り方は試験に写さない。** */
    function leaseFile(dir: string): string {
      const name = readdirSync(join(dir, ".git")).find(
        (entry) => entry.startsWith("valence-loop-lease-worker") && !entry.endsWith(".lock"),
      );
      expect(name, `lease の記録が見つからない: ${dir}`).toBeDefined();
      return join(dir, ".git", name ?? "");
    }

    it("NAME_MAX を超える長さの作業場でも、取れて返せる", () => {
      const deep = deepWorkspace();

      const held = runIn(deep, ["acquire", "worker", stampFor("worker")]);

      expect(held.status, held.stderr).toBe(0);
      expect(runIn(deep, ["release", "worker", held.stdout.trim()]).status).toBe(0);
    });

    it("作業場の長さが違っても、記録の名前は同じ長さになる", () => {
      // **「深いところでも動いた」だけでは足りない。** それだと**もっと深い checkout で
      // 同じところへ戻る**——**長さを入力に依存させない**ことが直したい性質である
      const deep = deepWorkspace();
      expect(acquire().status).toBe(0);
      expect(runIn(deep, ["acquire", "worker", stampFor("worker")]).status).toBe(0);

      const shallowName = leaseFile(sandbox).replace(/^.*\//, "");
      const deepName = leaseFile(deep).replace(/^.*\//, "");

      expect(deep.length, "作業場の長さが変わっていない").toBeGreaterThan(sandbox.length + 100);
      expect(deepName.length, "記録の名前が作業場の長さで伸びている").toBe(shallowName.length);
    });

    it("どの作業場が握っているかは、記録の中身を読めば分かる", () => {
      // **名前から畳んだパスを外すと、そこにあった情報が消える。**
      // **固定長にしたついでに「誰が握っているか」を読めなくしても、
      // 名前の長さだけを見る試験は緑のまま通る**（#183 で直したのと同じ形）
      const deep = deepWorkspace();
      expect(runIn(deep, ["acquire", "worker", stampFor("worker")]).status).toBe(0);

      expect(readFileSync(leaseFile(deep), "utf8")).toContain(deep);
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
      expect(run(["acquire", "master", stampFor("master")]).status).toBe(0);
      const master = readdirSync(join(sandbox, ".git")).find(
        (entry) => entry === "valence-loop-lease-master",
      );
      expect(master).toBeDefined();
      writeFileSync(
        join(sandbox, ".git", master ?? ""),
        `deadbeefdeadbeef\t${Math.floor(Date.now() / 1000) - 3600}\n`,
      );

      expect(run(["heartbeat", "worker"]).status).toBe(0);
      const retaken = run(["acquire", "master", stampFor("master")]);

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
      // **1 行目が窓に使う値**（2 行目からは直近の実測。#146）
      const seconds = Number(
        readFileSync(join(sandbox, ".git", lengths[0] ?? ""), "utf8").split("\n")[0],
      );

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
      const seconds = Number(
        readFileSync(join(sandbox, ".git", longest ?? ""), "utf8").split("\n")[0],
      );

      expect(seconds).toBeGreaterThanOrEqual(300);
    });

    /**
     * `seconds` 秒かかった周回を 1 つ回す。**待たずに作る**——lease の取得時刻を
     * 過去へずらす（他の試験と同じ手）。
     */
    function round(seconds: number): void {
      const token = acquire().stdout.trim();
      const rounds = readdirSync(join(sandbox, ".git")).find((entry) =>
        entry.startsWith("valence-loop-rounds-worker"),
      );
      const lease = join(sandbox, ".git", (rounds ?? "").replace("rounds", "lease"));
      const held = readFileSync(lease, "utf8").split("\n");
      held[0] = `${token}\t${Math.floor(Date.now() / 1000) - seconds}`;
      writeFileSync(lease, held.join("\n"));
      expect(run(["release", "worker", token]).status).toBe(0);
    }

    /** 記録の中身（1 行目 = 窓に使う値、以降 = 直近の実測）。 */
    function roundLenLines(): string[] {
      const name = readdirSync(join(sandbox, ".git")).find((entry) =>
        entry.startsWith("valence-loop-roundlen-worker"),
      );
      return readFileSync(join(sandbox, ".git", name ?? ""), "utf8")
        .trim()
        .split("\n");
    }

    /**
     * 窓が、古い実測に引きずられ続けない（#146）。
     *
     * **最大値だけを残すと単調に増える。** 機械が詰まった・`./task check` が異常に
     * 長引いた・人が止めて放置した——**どれか 1 回で窓が広がり、二度と戻らない**。
     * **実測で 4239 秒（70.7 分）が残っていた**——**その日の周回はどれも数分**である。
     *
     * **「短いほうへ倒す」だけにはしない。** 短い周回で上書きすると、
     * **長い周回の途中で「止まっている」と読まれる**（#129 / #142 が入れた性質）。
     */
    it("1 回だけ長い周回は、何周かしたら落ちる", () => {
      // **lease の期限より短くしておく**（超えると release ではなく引き継ぎになる）
      round(1500);
      expect(Number(roundLenLines()[0])).toBeGreaterThanOrEqual(1500);

      // **同じ機械で、ふだんの周回を続ける**
      for (let index = 0; index < 10; index += 1) {
        round(30);
      }

      expect(Number(roundLenLines()[0]), "古い異常値を引きずっている").toBeLessThan(1500);
    });

    it("直後の周回では、まだ落ちない", () => {
      // **忘れるのが速すぎると、長い周回の途中で止められる**——
      // **同じ Issue を続けている間は、その重さを覚えている**こと
      round(1500);
      round(30);

      expect(Number(roundLenLines()[0]), "1 周で忘れている").toBeGreaterThanOrEqual(1500);
    });

    it("記録が伸び続けない", () => {
      // **直近の分だけを残す。** 際限なく足すと、**読むたびに重くなる**
      for (let index = 0; index < 20; index += 1) {
        round(10);
      }

      expect(roundLenLines().length, "記録が周回のたびに伸びている").toBeLessThan(20);
    });

    it("1 行目は、窓に使う値である", () => {
      // **記録は版をまたいで共有される**（`bin/loop-lease` の lease ファイルで踏んだ）。
      // **古い読み手は 1 行目しか読まない**ので、**そこに窓の値を置く**——
      // 履歴を 1 行目に置くと、**古い `bin/loop-stall` が直近 1 回だけで窓を作る**
      round(1500);
      round(30);

      const lines = roundLenLines();
      const history = lines.slice(1).map(Number);

      expect(Number(lines[0]), "1 行目が最大になっていない").toBe(Math.max(...history));
    });

    it("前の版が書いた記録（1 行だけ）の値は、そこで捨てる", () => {
      // **移行の一度きりの経路**（1 行目は「窓に使う値」であって履歴ではないので、
      // **履歴へ入れない**）。**これが実測で残っていた 4239 そのもの**である。
      //
      // **「60 以上」だけでは、捨てたことを言っていない**——**4239 のままでも通る**
      // ので、**1 行目を履歴へ入れる回帰を 1 度も見ていない**（#175 のレビュー）。
      round(30);
      const name = readdirSync(join(sandbox, ".git")).find((entry) =>
        entry.startsWith("valence-loop-roundlen-worker"),
      );
      writeFileSync(join(sandbox, ".git", name ?? ""), "4239\n");

      round(60);

      const seconds = Number(roundLenLines()[0]);
      expect(seconds, "新しい実測が入っていない").toBeGreaterThanOrEqual(60);
      expect(seconds, "前の版の値を履歴へ引き継いでいる").toBeLessThan(4239);
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
