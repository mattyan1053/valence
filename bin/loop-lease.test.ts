import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
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

      expect(old.status, "印を渡さずに取れてしまう").toBe(3);
      expect(old.stdout, "取れたことにしている").toBe("");
    });

    it("印を渡さない版のぶんは、こちらで積む", () => {
      // **その周回は自分では積めない** (#244)。**「印がずれたら procedure-stale」
      // という行が、古い本文には無い**——**止まるだけで誰も呼ばれない。**
      //
      // **積むのは「印が無い」ときだけ。** **印がずれた側は、呼び直しを 1 回
      // 挟んでから呼ぶ側が積む**（**ここで積むと 1 件が 2 つ数えられる**）。
      run(["acquire", "worker"]);

      // **置き場所を書き写さない** (#239)。**`procedure-stale` は作業場ごとに数える**
      // ので、**ファイル名に scope が入る**——**名前を決めているのは本体**である
      const stalls = readdirSync(join(sandbox, ".git")).filter((entry) =>
        entry.startsWith("valence-loop-stall"),
      );
      expect(stalls, "記録が積まれていない").not.toEqual([]);
      expect(
        stalls.map((entry) => readFileSync(join(sandbox, ".git", entry), "utf8")).join(""),
        "procedure-stale として積んでいない",
      ).toContain("procedure-stale");
      // **積む先が使い捨ての作業場であることも、ここが同時に言っている**
      // ——**本物のカウンタを読んで「変わっていない」を見る本は置かない** (#261 のレビュー)。
      // **あれは他人の持ち物を合否に入れる形**で、**master が同じカウンタへ
      // 正規の記録を書いた瞬間に赤くなる** (#186)。**自分の砂場を見れば足りる。**
    });

    it("記録できなかったら、そこで止める", () => {
      // **積めなかったことを飲まない** (#261 のレビュー)。**この枝は古い版の周回の
      // ぶんを代わりに積むためにある**ので、**積めなければ目的を果たしていない。**
      // **設定を壊して `bin/loop-stall` を exit 2 にする**（**ロックを取れない場合と
      // 同じ行き先**）——**「記録できていない」は設定か環境の誤りの側である。**
      const broken = run(["acquire", "worker"], { LOOP_STALL_LOCK_WAIT_SEC: "-1" });

      expect(broken.status, "記録できていないのに、いつもの止まり方をしている").toBe(2);
      expect(broken.stderr).toMatch(/記録できませんでした/);
    });

    it("違う印なら取れない（配られたテキストが古い）", () => {
      const stale = run(["acquire", "worker", "0123456789ab"]);

      // **exit 2 と分ける** (#244)。**exit 2 は「設定か環境の誤り」**で、
      // **行き先が違う**——**文言でしか見分けられない状態を残さない。**
      expect(stale.status).toBe(3);
      expect(stale.stderr, "捨てて呼び直す先が書いていない").toMatch(/procedure-stale/);
    });

    it("案内が、印を持つ木へ入る道を言う", () => {
      // **止まった状態から出られるかを見る** (#184 / #262)。
      //
      // **印を変える PR を出した作業場は、次の周回から入れなくなる**——
      // **その PR を直す周回にも入れない**ので、**PR が自分自身で詰む**（#261 で実測）。
      //
      // **逃げ道はある**（**その枝を checkout すれば、手順書もスクリプトも揃う**）が、
      // **どこにも書かれていなかった**。**`acquire` は周回の冒頭で、checkout は
      // それより後**なので、**普通に周回を始めるかぎり、そこへ到達しない。**
      //
      // **案内は「印を埋めて取り直す」しか言っていなかった**——
      // **同じ印を渡しても、また止まる。**
      const stale = run(["acquire", "worker", "0123456789ab"]);

      expect(stale.stderr, "印を持つ木へ入る道が書いていない").toMatch(/checkout/);
      expect(stale.stderr, "何を checkout すればよいのかが書いていない").toMatch(/PR|枝/);
      // **案内も、押さえてから入る形にそろえる**（#268 のレビュー 2 周目）。
      // **手順書は `recover` へ直したが、案内には `held` → checkout が残っていた**——
      // **この案内を実際に読むのは、古い手順書を配られた周回**である。
      // **読むだけの確認と checkout の間に、別の周回が `acquire` を通せる**（#68）。
      expect(stale.stderr, "案内が、読むだけの確認のまま").toContain("recover");
      expect(stale.stderr, "案内に古い順序が残っている").not.toMatch(/loop-lease held/);
    });

    it("同じ印なら、これまでどおり取れる", () => {
      // **止めすぎていないこと**（正常な周回で鳴らない）
      expect(run(["acquire", "worker", stampFor("worker")]).status).toBe(0);
    });
  });

  describe("回復のために押さえる", () => {
    /**
     * **印がずれた周回が、木を入れ替える前に作業場を押さえる**（#268 のレビュー）。
     *
     * **読むだけの確認では足りない。** `held` を見てから `gh pr checkout` を打つまでの間に、
     * **別の周回が普通の `acquire` を通せる**——**その直後に checkout すると、
     * 走っている周回の HEAD と作業ツリーを入れ替える**（#68 の形）。
     *
     * **押さえることは、進んでよいという意味ではない。** **揃ったかどうかは、
     * checkout したあとに `bin/loop-procedure-stamp` で確かめる**（判定はそこ 1 箇所）。
     */
    it("印がずれていれば、押さえられる", () => {
      const held = run(["recover", "worker", "0123456789ab"]);

      expect(held.status, held.stderr).toBe(0);
      expect(held.stdout.trim(), "token が出ていない").toMatch(/^[0-9a-f]{16}$/);
    });

    it("押さえたぶんは、これまでどおり返せる", () => {
      const token = run(["recover", "worker", "0123456789ab"]).stdout.trim();

      expect(run(["release", "worker", token]).status).toBe(0);
    });

    it("走っている周回があるなら、押さえない", () => {
      // **ここが `held` との違い**——**読んで空けたままにせず、その場で決着させる**
      expect(acquire().status).toBe(0);

      expect(run(["recover", "worker", "0123456789ab"]).status, "走っているのに押さえた").toBe(1);
    });

    it("印が揃っているなら、ここは使えない", () => {
      // **素通りの口にしない。** **回復は「ずれている」状態のためだけのもの**である
      const same = run(["recover", "worker", stampFor("worker")]);

      expect(same.status, "揃っているのに回復で取れる").toBe(3);
      expect(same.stdout, "取れたことにしている").toBe("");
      expect(same.stderr).toMatch(/acquire/);
    });

    it("使い方の誤りは、押さえる前に落ちる", () => {
      expect(run(["recover", "worker"]).status).toBe(2);
      expect(run(["recover", "worker", "0123456789ab", "余計"]).status).toBe(2);
      expect(run(["recover", "それ以外の役", "0123456789ab"]).status).toBe(2);
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

    it("貼っても構文で壊れず、スクリプトまで届く", () => {
      // **`<役>` を出していた版はここで落ちる**（`syntax error near unexpected token`）。
      // **bash の構文エラーも usage も終了コードは 2** なので、**番号では分けない**
      // ——**「走ったか」は、スクリプトの出力が返っているかで見る。**
      for (const line of suggested(run(["check"]).stderr)) {
        const pasted = paste(line);

        expect(pasted.stderr, `貼ると壊れる: ${line}`).not.toMatch(/syntax error/);
        // **答えは「印が違う」で構わない**（場所取りを埋めていないので当然である）
        // ——**見たいのは「スクリプトが答えたか」**であって、通ったかではない
        expect(pasted.stderr, `スクリプトまで届いていない: ${line}`).toMatch(/^(\[NG\]|使い方:)/m);
      }
    });

    it("印は実値で埋めない", () => {
      // **印は「読んだ側が申告する」ことに意味がある** (#243。#257 のレビュー)。
      // **ディスクから計算して渡すと突き合わせは必ず一致し、古い手順書で
      // 走っている周回がそのまま取れてしまう**——**この案内が出るのは、
      // まさにその周回**である。
      const stamp = stampFor("worker");

      for (const line of suggested(run(["check"]).stderr)) {
        expect(line, `印を実値で埋めている: ${line}`).not.toContain(stamp);
        expect(line, `埋める場所が無い: ${line}`).toMatch(/"<[^"]*印[^"]*>"/);
      }
    });

    it("何が起きたのかを、印を付けて言う", () => {
      // **このスクリプトは `[FAIL]` / `[WARN]` / `[NG]` で状態を告げる。**
      // **印が無いと、出力を印で拾う読み手からは一件も見えない** (#257 のレビュー)。
      // **案内だけが残ると、先頭は空白で始まる「いま取り直してください」**になり、
      // **何が起きたのかを言う行が無くなる。**
      const advice = run(["check"]);

      expect(advice.stderr, "持っていないことを告げる行が無い").toMatch(
        /^\[WARN\].*lease を持っていません/m,
      );
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

    it("誰も持っていないとき、どの範囲について答えたのかを出す", () => {
      // **これが本題** (#250)。**worker の lease は作業場ごとに分かれている**ので、
      // **別の作業場から呼ぶと、そこには誰も居ないぶん、いつでも exit 1 になる。**
      // **master が「解放済み」と読んで worker へ伝え、実際は 7 分取れなかった**
      // （2026-08-14。**答えは正しく、問いが違っていた**）。
      //
      // **exit 1 のときこそ出す**——**「誰も持っていない」と「この作業場には無い」が、
      // 同じ顔をしているのが本体**である。
      const answered = run(["held", "worker"]);

      expect(answered.status).toBe(1);
      expect(answered.stderr, "どの作業場について答えたのかが出ていない").toContain(sandbox);
      expect(answered.stderr, "別の作業場を見る行き先が出ていない").toContain("busy");
    });

    it("持っているときも、どの範囲かを出す", () => {
      acquire();

      const answered = run(["held", "worker"]);

      expect(answered.status).toBe(0);
      expect(answered.stderr).toContain(sandbox);
    });

    it("master の答えは、範囲で分かれない", () => {
      // **master の lease は作業場で分かれない**ので、**振る舞いを変えない**
      // ——**作業場のパスを出すと、分かれているように読める**
      const answered = run(["held", "master"]);

      expect(answered.status).toBe(1);
      expect(answered.stderr, "master は作業場で分かれない").not.toContain(sandbox);
    });

    it("master には、別の作業場の案内を出さない", () => {
      // **役ごとに置き場所が違う** (#283 のレビュー)。**master の記録は 1 つだけ**なので、
      // **`busy master` は `held master` と同じものを見る**——**「別の作業場も見るなら」と
      // 案内しても、行き先が同じ**である。
      //
      // **#250 と同じ形をここで作らない**——**答えは正しいのに、問いの説明が違う。**
      const answered = run(["held", "master"]);

      expect(answered.status).toBe(1);
      expect(answered.stderr, "master に worker 向けの案内が出ている").not.toContain("busy");
    });

    it("使い方の行に、答える範囲が書いてある", () => {
      // **使い方を読んだだけで「呼んだ作業場のことだ」と分かること**（#250 の完了条件）
      const usage = run([]).stderr;
      const line = usage.split("\n").find((row) => row.includes("held")) ?? "";

      expect(line, "held の行が無い").not.toBe("");
      expect(line, "答える範囲が書かれていない").toContain("作業場");
    });
  });

  /**
   * **この token が、いま握られている lease のものか**を答える口（#352 / #355 のレビュー）。
   *
   * **周回はセッションでは区別できない。** **`round_owner` の真上にそう書いてある**
   * ——**cron の周回と通知の周回は同じ本体から起きる**ので、**同じ値になる。**
   * **入口 1.0 が直列化しようとしているのは、まさにその 2 つ**である
   * ——**そこで「この周回のものだ」と答えたら、塞ぎに来た競合がそのまま残る。**
   *
   * **周回ごとに違う証拠は最初からある**——**`acquire` が返し、`release` が要求する
   * token** である。**資格は token が持つ**（`release` と同じ線）。
   */
  describe("mine — この token が、いま握られている lease のものか", () => {
    /**
     * **別のセッションとして lease を取る。**
     *
     * **`round_owner` は「自分のセッションの外に出たところ」を印にする**ので、
     * **同じセッションの中で bash を挟んでも同じ値のまま**である
     * ——**`setsid` で切り離して初めて別セッションになる。**
     */
    function acquireInAnotherSession(role = "worker"): void {
      const result = spawnSync(
        "setsid",
        ["--wait", "bash", "-c", `"${SCRIPT}" acquire ${role} ${stampFor(role)}`],
        { cwd: sandbox, encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
    }

    it("いま握られている token なら 0 を返す", () => {
      const token = acquire().stdout.trim();

      expect(run(["mine", "worker", token]).status).toBe(0);
    });

    it("誰も持っていなければ 1 を返す", () => {
      expect(run(["mine", "worker", "0123456789abcdef"]).status).toBe(1);
    });

    it("返したあとは 1 を返す", () => {
      // **出口で先に返した周回**が、この形になる
      const token = acquire().stdout.trim();
      expect(run(["release", "worker", token]).status).toBe(0);

      expect(run(["mine", "worker", token]).status).toBe(1);
    });

    it("同じセッションの中で別の周回が取り直していれば、1 を返す", () => {
      // **これが本題** (#355 のレビュー)。**古い周回が返した直後に、cron の周回が
      // 同じ lease を取る**——**セッションの印では 2 つが同じ値になる**ので、
      // **古い周回の `--sent` が通ってしまっていた。**
      //
      // **`setsid` は要らない。** **実運用の形は、同じ本体から起きる 2 周回**である。
      const previous = acquire().stdout.trim();
      expect(run(["release", "worker", previous]).status).toBe(0);
      const current = acquire().stdout.trim();

      expect(current, "同じ token が返っていて、区別のしようがない").not.toBe(previous);
      expect(run(["mine", "worker", previous]).status, "古い周回のものと読んでいる").toBe(1);
      expect(run(["mine", "worker", current]).status, "いまの周回が締め出されている").toBe(0);
    });

    it("別のセッションが持っていても、自分のものとは読まない", () => {
      // **`held` との違いはここ**である——**あちらは 0 を返す**（誰かが持っている）
      acquireInAnotherSession();

      expect(run(["held", "worker"]).status, "誰かが持っている状態になっていない").toBe(0);
      expect(
        run(["mine", "worker", "0123456789abcdef"]).status,
        "他人の lease を自分のものと読んでいる",
      ).toBe(1);
    });

    it("役ごとに見る", () => {
      const token = acquire("master").stdout.trim();

      expect(run(["mine", "master", token]).status).toBe(0);
      expect(run(["mine", "worker", token]).status, "役をまたいで通している").toBe(1);
    });

    it("読むだけで、状態を変えない", () => {
      const token = acquire().stdout.trim();

      expect(run(["mine", "worker", token]).status).toBe(0);
      expect(run(["release", "worker", token]).status, "見ただけで返せなくなっている").toBe(0);
    });

    it("token を渡さなければ、使い方の誤りとして落ちる", () => {
      // **古い手順書が打つ形**である（#340 の版）——**「持っている」へ倒さない**
      expect(run(["mine", "worker"]).status).toBe(2);
    });

    it("知らない役は 2 で落ちる", () => {
      // **判定不能を「持っていない」へ倒さない**——**綴り違いで、正常な周回の
      // 記録が上がらなくなる**
      expect(run(["mine", "workers", "0123456789abcdef"]).status).toBe(2);
    });

    it("周回の途中で記録の名前が変わっても、引き当てる", () => {
      // **worker は周回の途中で作業ツリーを入れ替える**（1.1 の同期、`gh pr checkout`）
      // ——**`bin/loop-lease` 自身もそこで入れ替わる**ので、**記録の名前の作り方が
      // 変わりうる**（#240）。**`release` は token で引き直している**——
      // **こちらだけ名前で引くと、正しい順序の周回が「持っていない」に化ける。**
      const token = acquire().stdout.trim();
      const dir = join(sandbox, ".git");
      const current = readdirSync(dir).find((name) => name.startsWith("valence-loop-lease-worker"));
      expect(current, "lease の記録が見つからない").toBeDefined();
      renameSync(join(dir, current ?? ""), join(dir, "valence-loop-lease-worker_前の版の名前"));

      expect(run(["mine", "worker", token]).status, "名前でしか引いていない").toBe(0);
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

    /**
     * 取得時刻を過去へずらす。**待たずに古い状態を作る**（#131 の教訓）。
     *
     * **1 行目の時刻だけを差し替える。** **残りの行（持ち主・作業場）を落とすと、
     * 実際には在るものが試験の中だけ消え**——**持ち主で分かれる経路が、
     * どちらへ倒しても緑になる**（#260 で実際に踏んだ）。
     */
    function ageLease(secondsAgo: number): void {
      const file = stateFile();
      const lines = readFileSync(file, "utf8").split("\n");
      const token = (lines[0] ?? "").split("\t")[0] ?? "";
      lines[0] = `${token}\t${Math.floor(Date.now() / 1000) - secondsAgo}`;
      writeFileSync(file, lines.join("\n"));
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
      // **あとどれだけ待てばよいかを出す** (#251)。**「待てば済む」のか
      // 「そうでない」のかが、その場で分かる**
      expect(second.stderr, "残りが読めない").toMatch(/あと\s*-?\d+\s*秒/);
    });

    /**
     * **期限切れは、重なりではない** (#260)。
     *
     * **master の周回は `./task` をほとんど通らない**ので、**心拍が打たれず、
     * 周回の長さに関わらず TTL で外れる**——**実測で 387 秒超過していた。**
     *
     * **走っている本人は気づかない。** **期限を見るのは `acquire` だけ**で、
     * **気づくのは出口の `release` が断ったとき**である。
     * **そのときの文言が「別の周回が持っています」**だと、**読んだ側は重なったと
     * 解釈する**——**実際には誰も持っていない**（**期限切れの自分の記録が残っているだけ**）。
     */
    describe("期限が切れた自分の記録を、重なりと区別する", () => {
      it("切れていても、同じ token なら返せる", () => {
        // **返す資格は token が持つ。** **切れたからといって、持ち主の後始末を断らない**
        const token = acquire().stdout.trim();
        ageLease(3600);

        const released = run(["release", "worker", token]);

        expect(released.status, "持ち主が返せない").toBe(0);
      });

      it("切れていたことを、返すときに言う", () => {
        // **黙って通すと、重なりが起きていたことに誰も気づかない**
        const token = acquire().stdout.trim();
        ageLease(3600);

        const released = run(["release", "worker", token]);

        expect(released.stderr, "期限切れだったことを言っていない").toMatch(/期限切れ/);
      });

      it("切れた記録が自分のものでなければ、そう言う", () => {
        // **落ちた別の周回の跡**である。**「誰も持っていない」でも「重なっている」でもない**
        acquire();
        ageLease(3600);

        const released = run(["release", "worker", "0000000000000000"]);

        expect(released.status).toBe(1);
        expect(released.stderr, "期限切れの記録だと読めない").toMatch(/期限切れの記録/);
        expect(released.stderr, "重なりと同じ文言にしている").not.toContain(
          "別の周回が持っています",
        );
      });

      it("切れた記録を返しても、周回の長さに数えない", () => {
        // **`bin/loop-stall` の窓は、実際にかかった時間から決まる** (#146)。
        // **切れたまま放置された記録の「長さ」を入れると、窓が広がって戻らない**
        const token = acquire().stdout.trim();
        ageLease(36000);

        expect(run(["release", "worker", token]).status).toBe(0);

        const lengths = readdirSync(join(sandbox, ".git")).find((entry) =>
          entry.startsWith("valence-loop-roundlen"),
        );
        const recorded = lengths ? readFileSync(join(sandbox, ".git", lengths), "utf8") : "";
        expect(recorded, "期限切れの周回を長さとして数えている").not.toMatch(/\b36000\b/);
      });

      it("切れていないのに token が違えば、これまでどおり重なりと言う", () => {
        // **誤検知を消すために、本当の重なりまで消さない**
        acquire();

        const released = run(["release", "worker", "0000000000000000"]);

        expect(released.status).toBe(1);
        expect(released.stderr).toContain("別の周回が持っています");
      });

      it("引き継がれた後も、返しに来た持ち主に言う", () => {
        // **いちばん知りたいのは重なった後**である (#278 のレビュー)。
        // **記録は取り直した側が上書きしている**ので、**プロセス内の変数だけでは
        // 何も言えない**——**跡を残す側が要る。**
        //
        // **取り直すのは別の周回である。** **同じセッションから取ると、跡は取得時に
        // 消費される**（**自分宛ての跡は、誰にも伝える必要が無い**）
        const mine = acquire().stdout.trim();
        ageLease(3600);
        expect(acquireAsOtherRound().status, "引き継げていない").toBe(0);

        const released = run(["release", "worker", mine]);

        expect(released.status).toBe(1);
        expect(released.stderr, "取り直されたことが読めない").toMatch(/別の周回が取り直/);
      });

      /**
       * **別の周回として取る。**
       *
       * **持ち主の印は、シェルを分けても変わらない**——**`round_owner` は
       * セッションの外側を見る**（**1 周回が複数のシェルに分かれても同じ値**にするため）。
       * **`setsid` で切り離して、初めて別の周回になる**——**ここを間違えると、
       * 「別の周回が取り直した」つもりの入力が作れていない。**
       */
      function acquireAsOtherRound(): Run {
        const taken = spawnSync(
          "setsid",
          ["--wait", SCRIPT, "acquire", "worker", stampFor("worker")],
          { cwd: sandbox, encoding: "utf8", env: { ...process.env } },
        );
        return { status: taken.status ?? -1, stdout: taken.stdout, stderr: taken.stderr };
      }

      it("引き継がれた後も、入口の検査が言う", () => {
        // **A は `bin/loop-await-review` で待っている間、何も打たない**（最大 480 秒）
        // ——**切れてから重なるまでの窓を、待ったまま踏み越える**
        acquire();
        ageLease(3600);
        expect(acquireAsOtherRound().status, "引き継げていない").toBe(0);

        const checked = run(["check"]);

        expect(checked.stderr, "取り直されたことが読めない").toMatch(/別の周回が取り直/);
        expect(checked.stderr, "飛ばしたと誤診している").not.toContain("acquire を飛ばした");
      });

      it("引き継がれた跡は、増え続けない", () => {
        // **記録は溜まる一方にしない**（`record_missing` と同じ判断）
        for (let round = 0; round < 8; round += 1) {
          acquireAsOtherRound();
          ageLease(3600);
        }
        acquireAsOtherRound();

        const name = readdirSync(join(sandbox, ".git")).find((entry) =>
          entry.startsWith("valence-loop-superseded"),
        );
        const kept = name
          ? readFileSync(join(sandbox, ".git", name), "utf8")
              .trimEnd()
              .split("\n")
          : [];
        expect(kept.length, "際限なく積んでいる").toBeLessThanOrEqual(5);
      });

      it("引き継がれた跡を、飛ばした周回として数えない", () => {
        // **`./task loop:status` は「入口を飛ばした周回」を数えている。**
        // **原因の違うものを混ぜると、読めなくなる**
        acquire();
        ageLease(3600);
        expect(acquireAsOtherRound().status, "引き継げていない").toBe(0);

        run(["check"]);

        const missing = readdirSync(join(sandbox, ".git")).find((entry) =>
          entry.startsWith("valence-loop-lease-missing"),
        );
        const recorded = missing ? readFileSync(join(sandbox, ".git", missing), "utf8") : "";
        expect(recorded, "飛ばした周回として数えている").toBe("");
      });

      it("取り直した側が返した後も、返しに来た持ち主に言う", () => {
        // **記録は B が返した時点で消える** (#278 のレビュー)。**跡はファイルに在るのに、
        // 見にいく者がいない**——**プロセス内の変数だけを見ていた。**
        const mine = acquire().stdout.trim();
        ageLease(3600);
        const other = acquireAsOtherRound();
        expect(other.status, "引き継げていない").toBe(0);
        expect(run(["release", "worker", other.stdout.trim()]).status).toBe(0);

        const released = run(["release", "worker", mine]);

        expect(released.status).toBe(1);
        expect(released.stderr, "取り直されたことが読めない").toMatch(/別の周回が取り直/);
      });

      it("取り直した側が返した後も、入口の検査が言う", () => {
        const mine = acquire().stdout.trim();
        expect(mine).not.toBe("");
        ageLease(3600);
        const other = acquireAsOtherRound();
        expect(run(["release", "worker", other.stdout.trim()]).status).toBe(0);

        const checked = run(["check"]);

        expect(checked.stderr, "取り直されたことが読めない").toMatch(/別の周回が取り直/);
      });

      it("次の周回で取り直したら、跡はもう当たらない", () => {
        // **`round_owner` はセッションの外側を見る**ので、**同じセッションの周回は
        // 何周しても同じ値**である——**跡が残ったままだと、後の健全な周回で誤報が出る。**
        // **そのとき `exit 0` するので、本当に入口を飛ばした周回が記録されない**
        // ——**「件数を汚さない」枝が、汚さない代わりに消すことになる**（§5）。
        acquire();
        ageLease(3600);
        const other = acquireAsOtherRound();
        expect(run(["release", "worker", other.stdout.trim()]).status).toBe(0);
        // **取り直して、返す。** ここで跡は役目を終える
        const again = acquire().stdout.trim();
        expect(again, "取り直せていない").not.toBe("");
        expect(run(["release", "worker", again]).status).toBe(0);

        // **そのあと、本当に入口を飛ばした周回が来る**
        const checked = run(["check"]);

        expect(checked.stderr, "健全な周回で誤報している").not.toMatch(/別の周回が取り直/);
        expect(checked.stderr, "飛ばした周回だと言えていない").toContain("acquire を飛ばした");
        const missing = readdirSync(join(sandbox, ".git")).find((entry) =>
          entry.startsWith("valence-loop-lease-missing"),
        );
        expect(
          missing ? readFileSync(join(sandbox, ".git", missing), "utf8") : "",
          "飛ばした周回が記録されていない",
        ).not.toBe("");
      });

      it("返すときに、引き継ぎの案内を出さない", () => {
        // **`release` は引き継いでいない** (#278 のレビュー)。
        // **文言を直しに来て、逆の文言を 1 行増やしては元も子もない**
        const token = acquire().stdout.trim();
        ageLease(3600);

        const released = run(["release", "worker", token]);

        expect(released.stderr, "引き継ぐと言っている").not.toContain("引き継ぎます");
      });

      it("走っている最中に切れたことを、入口の検査が言う", () => {
        // **気づく手立てが `release` だけだと、気づいたときには重なっている。**
        // **`bin/loop-*` を打つたびに通る検査**で言えば、**周回の途中で分かる**
        acquire();
        ageLease(3600);

        const checked = run(["check"]);

        expect(checked.status, "止めてはいけない").toBe(0);
        expect(checked.stderr, "期限切れだと言っていない").toMatch(/期限切れ/);
      });

      it("走っている最中に切れたのを、入口を飛ばしたと言わない", () => {
        // **原因が違う。** **飛ばした周回は取り直せばよい**が、
        // **切れた周回は「重なったかもしれない」を疑う**——**案内が別である**
        acquire();
        ageLease(3600);

        const checked = run(["check"]);

        expect(checked.stderr, "飛ばしたと誤診している").not.toContain("acquire を飛ばした");
      });
    });

    /**
     * **伸ばしてよいのは、持ち主の周回だけ** (#251)。
     *
     * **`./task` は周回の外からも打たれる**（人が手で叩く）——**打った人が持ち主で
     * なくても同じように伸びていた。** **実測では、取り落とした lease が
     * 「待てば切れる」と読めるのに切れず**、**worker は事実上いつまでも動けなかった。**
     *
     * **殺さない側は変えない。** **長い周回が途中で奪われるのを防ぐのが、この仕組みの
     * 目的**である——**持ち主の心拍は、これまでどおり伸ばす。**
     */
    describe("伸ばすのは、持ち主の周回だけ", () => {
      /** 別の周回として心拍を打つ。**`setsid` で切り離して初めて別の周回になる。** */
      function heartbeatAsOtherRound(): number {
        const beat = spawnSync("setsid", ["--wait", SCRIPT, "heartbeat", "worker"], {
          cwd: sandbox,
          encoding: "utf8",
          env: { ...process.env },
        });
        return beat.status ?? -1;
      }

      it("別の周回が打っても、取り落とした lease は伸びない", () => {
        // **これが本題。** **待っている間も伸びていた**ので、**いつまでも切れない**
        expect(acquire().status).toBe(0);
        ageLease(3600);

        expect(heartbeatAsOtherRound(), "心拍そのものは落とさない").toBe(0);
        const second = acquire();

        expect(second.status, "取り落とした lease が伸び続けている").toBe(0);
        expect(second.stderr).toContain("引き継ぎます");
      });

      it("持ち主の心拍は、これまでどおり伸ばす", () => {
        // **走っている周回を殺さない。** **それがこの仕組みの目的**である
        expect(acquire().status).toBe(0);
        ageLease(3600);

        expect(run(["heartbeat", "worker"]).status).toBe(0);
        const second = acquire();

        expect(second.status, "走っている周回を奪っている").toBe(1);
        expect(second.stderr).not.toContain("引き継ぎます");
      });

      it("照合と書き込みを、同じロックの中で行う", () => {
        // **「持ち主だ」と読んだ時点と、書く時点が別だと、間に `acquire` が入れる**
        // ——**古い周回の心拍が、新しい持ち主の期限を伸ばす** (#280 のレビュー)。
        //
        // **競り自体は試験にしない**（時間に依存する。#131 で直した形を作り直すことになる）
        // ——**代わりに、錠を開ける位置を見る。** **書き込みより前に開けていたら赤。**
        const script = readFileSync(SCRIPT, "utf8");
        const from = script.indexOf('if [[ $ACTION == "heartbeat" ]]; then');
        expect(from, "心拍のブロックが見つからない").toBeGreaterThanOrEqual(0);
        const block = script.slice(from).split("\nfi\n")[0] ?? "";
        const opened = block.indexOf("lock_state");
        const closed = block.indexOf("exec 9>&-");
        const written = block.indexOf("$ACTIVITY.tmp");

        expect(opened, "ロックを取っていない").toBeGreaterThanOrEqual(0);
        expect(written, "書き込みが見つからない").toBeGreaterThan(opened);
        if (closed >= 0) {
          expect(closed, "照合と書き込みの間で錠を開けている").toBeGreaterThan(written);
        }
      });

      it("持ち主が分からない記録は、伸ばす側へ倒す", () => {
        // **前の版が書いた lease には持ち主の行が無い**——**記録は版をまたいで共有される。**
        // **分からないものを殺しに行かない**（**偽の引き継ぎより、切れ残りのほうが安い**）
        expect(acquire().status).toBe(0);
        const file = stateFile();
        const token = (readFileSync(file, "utf8").split("\t")[0] ?? "").trim();
        writeFileSync(file, `${token}\t${Math.floor(Date.now() / 1000) - 3600}\n`);

        expect(heartbeatAsOtherRound()).toBe(0);
        const second = acquire();

        expect(second.status, "持ち主が分からない周回を奪っている").toBe(1);
      });
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

  describe("alive — その作業場が周回を回しているか", () => {
    // **生死の判定を 1 箇所に置く** (#296)。**`bin/loop-claim` は「claim の記録を
    // 触った時刻」で測っていた**——**PR を持つ worker は `resume` を打たない**ので、
    // **作業場が生きていても記録だけ古くなり、着手中の Issue を取り上げてしまう**
    // （2026-08-15 に実測）。
    //
    // **測るものは「周回を始めた印」**である（`bin/loop-stall` が使っているものと同じ）。
    // **lease と違って、返しても消えない**ので、**周回と周回の間でも読める。**

    /** その作業場の周回の印を、指定の時刻で置く。**名前の作り方は写さない。** */
    function markRound(dir: string, epoch: number | string): void {
      const scope = spawnSync(SCRIPT, ["scope", "worker"], { cwd: dir, encoding: "utf8" });
      expect(scope.status, scope.stderr).toBe(0);
      writeFileSync(
        join(sandbox, ".git", `valence-loop-rounds-${scope.stdout.trim()}`),
        `${epoch}\n`,
      );
    }

    it("周回の印が新しければ、走っていると答える", () => {
      markRound(sandbox, Math.floor(Date.now() / 1000));

      expect(run(["alive", sandbox]).status).toBe(0);
    });

    it("印が窓より古ければ、走っていないと答える", () => {
      markRound(sandbox, Math.floor(Date.now() / 1000) - 100_000);

      expect(run(["alive", sandbox]).status).toBe(1);
    });

    it("前の版の名前で置かれた印も、この作業場のものとして読む", () => {
      // **記録は版をまたいで共有される** (#298 のレビュー。#240 / #290 と同じ形)。
      // **持ち主が前の版で周回を始めていると、印は前の名前で残る**——
      // **いまの名前だけを見ると「回っていない」に落ち、生きている持ち主から
      // Issue を取り上げる**（**この PR が消しに来たもの**が、版の側から戻ってくる）。
      const scope = spawnSync(SCRIPT, ["scope", "worker"], { cwd: sandbox, encoding: "utf8" });
      expect(scope.status, scope.stderr).toBe(0);
      // **digest を切り詰めていた版**（実物の共通ディレクトリに残っている形）
      const truncated = scope.stdout.trim().slice(0, "worker-".length + 26);
      writeFileSync(
        join(sandbox, ".git", `valence-loop-rounds-${truncated}`),
        `${Math.floor(Date.now() / 1000)}\n`,
      );

      expect(run(["alive", sandbox]).status, "前の版の印を読み落としている").toBe(0);
    });

    it("パスを畳んでいた版の印も読む", () => {
      // **いちばん古い版**（#98 以前）。**`worker` の直後が `_` で、digest ではない**
      const folded = `worker${sandbox.replaceAll("/", "_")}`;
      writeFileSync(
        join(sandbox, ".git", `valence-loop-rounds-${folded}`),
        `${Math.floor(Date.now() / 1000)}\n`,
      );

      expect(run(["alive", sandbox]).status).toBe(0);
    });

    it("別の作業場の印は、この作業場のものにしない", () => {
      // **前の版の名前も見る**ようにしたぶん、**広く拾いすぎない**ことを見る
      // ——**他人が回っているだけで「この作業場が回っている」と答えると、
      // 落ちた作業場の Issue が誰にも拾えなくなる**
      const other = mkdtempSync(join(tmpdir(), "loop-lease-other-"));
      expect(spawnSync("git", ["init", "--quiet", other]).status).toBe(0);
      const scope = spawnSync(SCRIPT, ["scope", "worker"], { cwd: other, encoding: "utf8" });
      writeFileSync(
        join(sandbox, ".git", `valence-loop-rounds-${scope.stdout.trim()}`),
        `${Math.floor(Date.now() / 1000)}\n`,
      );
      rmSync(other, { recursive: true, force: true });

      expect(run(["alive", sandbox]).status, "別の作業場の印を自分のものにしている").toBe(1);
    });

    it("digest の頭が短すぎる名前は、この作業場のものにしない", () => {
      // **前の版の名前も見る**ようにしたので、**どこまでを「同じ作業場」と認めるか**を
      // 決めておく。**2 文字の頭は 256 分の 1 で他人と当たる**——**実在した版
      // （26 桁 / 64 桁）だけを認め、短すぎるものは別物として扱う。**
      const scope = spawnSync(SCRIPT, ["scope", "worker"], { cwd: sandbox, encoding: "utf8" });
      const tooShort = scope.stdout.trim().slice(0, "worker-".length + 2);
      writeFileSync(
        join(sandbox, ".git", `valence-loop-rounds-${tooShort}`),
        `${Math.floor(Date.now() / 1000)}\n`,
      );

      expect(run(["alive", sandbox]).status, "短い頭で他人と当たりうる").toBe(1);
    });

    it("自分の印が 1 つも無いところに知らない形があれば、判定できないと答える", () => {
      // **次の版が別の名前を使うかもしれない** (#298 のレビュー)。**こちらは
      // 「この作業場が名乗りえた名前」を数えている**ので、**知らない形は
      // 「自分のではない」と「まだ知らない」の区別が付かない**——
      // **回っていない側へ倒すと、また生きている持ち主から取り上げる。**
      writeFileSync(
        join(sandbox, ".git", "valence-loop-rounds-worker@まだ知らない形"),
        `${Math.floor(Date.now() / 1000)}\n`,
      );

      expect(run(["alive", sandbox]).status, "知らない形を素通りしている").toBe(2);
    });

    it("自分の既知の印があるなら、知らない形が混ざっていても判定できる", () => {
      // **印は消えない** (#298 の 2 周目のレビュー)。**知らない形が 1 つ置かれた
      // 瞬間から、どの作業場についても判定できなくなる**——**`bin/loop-claim resume` は
      // 永久に「判定できません」で、落ちた持ち主の `in-progress` を誰も回収できない。**
      // **「取り上げるより待つ」は正しいが、待ち続けて誰も拾えないのは別の壊れ方**である。
      //
      // **この作業場の名乗りが既に 1 つ見えているなら、知らない形はその作業場のもの
      // ではない**（**版が変わったなら、古い名乗りのほうが残る**）。
      markRound(sandbox, Math.floor(Date.now() / 1000) - 100_000);
      writeFileSync(
        join(sandbox, ".git", "valence-loop-rounds-worker@まだ知らない形"),
        `${Math.floor(Date.now() / 1000)}\n`,
      );

      expect(
        run(["alive", sandbox]).status,
        "無関係な作業場の印で、この作業場が判定できなくなっている",
      ).toBe(1);
    });

    it("作業場そのものが消えていれば、走っていないと答える", () => {
      // **`./task loop:worker:remove` で worktree を消しても、claim の記録は残る**
      // (#298 のレビュー)。**「判定できない」に倒すと、公開に失敗した `in-progress` の
      // Issue を誰も回収できない**——**消えた作業場は、回っていない。**
      const gone = mkdtempSync(join(tmpdir(), "loop-lease-gone-"));
      rmSync(gone, { recursive: true, force: true });

      expect(run(["alive", gone]).status, "消えた作業場で止まっている").toBe(1);
    });

    it("印が無ければ、走っていないと答える", () => {
      // **一度も周回を始めていない作業場**である。**引き継げなくなっては、
      // 落ちた周回の Issue が誰にも拾えない**
      expect(run(["alive", sandbox]).status).toBe(1);
    });

    it("印を読めなければ、判定できないと答える", () => {
      // **「読めない」を「走っていない」に倒さない**——**取り上げる側へ倒れる**
      markRound(sandbox, "こわれている");

      expect(run(["alive", sandbox]).status).toBe(2);
    });

    it("作業場が無ければ、走っていないと答える", () => {
      // **前は「判定できない」にしていた**が、**それだと消えた作業場の claim を
      // 誰も回収できない** (#298 のレビュー)——**無い作業場は回っていない。**
      expect(run(["alive", join(sandbox, "no-such-workspace")]).status).toBe(1);
    });

    it("印が窓から出ていても、lease を握っていれば走っていると答える", () => {
      // **印は「周回を始めた」しか言わない** (#298 の 2 周目のレビュー)。
      // **`acquire` が書いたきり周回の途中で更新されず、実測は `release` まで
      // 書かれない**——**初めての周回と、過去より長い周回は、走っている最中に
      // 窓から出る。** **当たるのはいちばん守りたい側**（長い実装を抱えた周回）で、
      // **#296 が消しに来た穴がそのまま戻る。**
      //
      // **lease は「いま走っている」を言う**——**別のことを測っているので、
      // 併せて見る。**
      expect(acquire().status).toBe(0);
      markRound(sandbox, Math.floor(Date.now() / 1000) - 100_000);

      expect(run(["alive", sandbox]).status, "走っている周回を止まっていると読んでいる").toBe(0);
    });

    it("期限切れの lease は、走っている根拠にしない", () => {
      // **落ちた周回の跡である。** **抱えたままの記録を「走っている」と読むと、
      // その作業場の Issue を誰も引き継げなくなる**——**引き継ぎのために期限を
      // 置いてあるのに、こちらだけが永久に生きていると答えることになる。**
      const stale = Math.floor(Date.now() / 1000) - Number(run(["ttl"]).stdout.trim()) - 600;
      writeFileSync(
        join(sandbox, ".git", "valence-loop-lease-worker-0123456789abcdef0123456789"),
        `deadbeef\t${stale}\np:1:1\n${realpathSync(sandbox)}\n`,
      );
      markRound(sandbox, stale);

      expect(run(["alive", sandbox]).status, "期限切れの lease を握っていると読んでいる").toBe(1);
    });

    it("持ち主の分からない lease が握られていれば、判定できないと答える", () => {
      // **どの作業場かは、名前ではなく中身で照らす** (#291)。**作業場の行が無い
      // 前の版の lease は帰属できない**——**この作業場のものかもしれない**ので、
      // **「走っていない」に倒すと、また生きている持ち主から取り上げる。**
      //
      // **印と違って、lease は期限で切れる**ので、**ここで待たせても永久には残らない。**
      writeFileSync(
        join(sandbox, ".git", "valence-loop-lease-worker-0123456789abcdef0123456789"),
        `deadbeef\t${Math.floor(Date.now() / 1000)}\np:1:1\n`,
      );

      expect(run(["alive", sandbox]).status, "帰属できない lease を素通りしている").toBe(2);
    });

    it("窓は実測から決まる（書き写した閾値を置かない）", () => {
      // **`bin/loop-stall` と同じ式**——**いちばん長かった周回の 2 倍**（既定は lease の期限）。
      // **長い周回の途中で「死んだ」に落とさない**
      const ttl = Number(run(["ttl"]).stdout.trim());
      const scope = spawnSync(SCRIPT, ["scope", "worker"], { cwd: sandbox, encoding: "utf8" });
      const started = Math.floor(Date.now() / 1000) - (ttl + 600);
      markRound(sandbox, started);
      expect(run(["alive", sandbox]).status, "実測が無ければ既定の窓で切れる").toBe(1);

      // 実測（いちばん長かった周回）を置くと、窓が広がる
      writeFileSync(
        join(sandbox, ".git", `valence-loop-roundlen-${scope.stdout.trim()}`),
        `${ttl + 1200}\n`,
      );

      expect(run(["alive", sandbox]).status, "実測が窓に効いていない").toBe(0);
    });
  });

  describe("周回の途中で版が入れ替わっても、自分の lease を返せる", () => {
    // **周回の途中で lease が消えた** (#240)。**消したものはいない**——
    // **記録の名前が、走っているスクリプトから毎回組み立てられる**ためである。
    //
    // **worker は周回の途中で作業ツリーを入れ替える**（1.1 の同期、`gh pr checkout`）
    // ——**`bin/loop-lease` 自身もそこで入れ替わる。** **取ったときと返すときで
    // 名前の作り方が違えば、自分が置いた記録を見つけられない**（`AGENTS.md` §5 の
    // 「名前を変えたら、古い名前を持つ者を数える」。#185）。
    //
    // **実物に跡が残っている。** この機械の共通ディレクトリには、**3 通りの名前**の
    // 記録が並んでいる——`worker_home_mattyan1053_valence`（パスをそのまま畳んだ版）、
    // `worker-<digest 26 桁>`（**どの main にも無い。PR の枝でだけ存在した版**）、
    // `worker-<digest 64 桁>`（いまの版）。**枝を checkout した周回が、そこにいた。**

    /**
     * **前の版**を作る。**名前の作り方だけを変える**（他は実物のまま）。
     *
     * **入口の印の突き合わせも通す**ので、**手順書と `loop-procedure-stamp` も
     * 同じ作業場へ置く**（`acquire` はディスクの手順書を見る）。
     */
    function olderVersion(formula = 'lease_scope="worker-${digest:0:26}"'): string {
      mkdirSync(join(sandbox, "bin"), { recursive: true });
      mkdirSync(join(sandbox, ".claude", "commands"), { recursive: true });
      copyFileSync(
        join(REPO_ROOT, ".claude/commands/loop-worker.md"),
        join(sandbox, ".claude/commands/loop-worker.md"),
      );
      copyFileSync(
        join(REPO_ROOT, "bin/loop-procedure-stamp"),
        join(sandbox, "bin", "loop-procedure-stamp"),
      );
      chmodSync(join(sandbox, "bin", "loop-procedure-stamp"), 0o755);
      const older = join(sandbox, "bin", "older-loop-lease");
      const source = readFileSync(SCRIPT, "utf8");
      const changed = source.replace('lease_scope="worker-${digest%% *}"', formula);
      expect(changed, "名前の作り方を差し替えられていない").not.toBe(source);
      writeFileSync(older, changed, { mode: 0o755 });
      return older;
    }

    /**
     * すべての記録を、期限の外へずらす。**待たずに古い状態を作る**（#131 の教訓）。
     *
     * **期限は「取得」と「最後の活動」の新しいほうから測る**ので、**両方ずらす。**
     */
    function ageRecords(): void {
      const old = Math.floor(Date.now() / 1000) - 100_000;
      const entries = readdirSync(join(sandbox, ".git"));
      for (const entry of entries.filter((name) => name.startsWith("valence-loop-activity-"))) {
        writeFileSync(join(sandbox, ".git", entry), `${old}\n`);
      }
      for (const entry of leaseRecords()) {
        const path = join(sandbox, ".git", entry);
        const lines = readFileSync(path, "utf8").split("\n");
        const [token = ""] = (lines[0] ?? "").split("\t");
        lines[0] = `${token}\t${old}`;
        writeFileSync(path, lines.join("\n"));
      }
    }

    /** その作業場の lease の記録（`.lock` は除く）。**名前の作り方は写さない。** */
    function leaseRecords(): string[] {
      return readdirSync(join(sandbox, ".git")).filter(
        (entry) => entry.startsWith("valence-loop-lease-worker") && !entry.endsWith(".lock"),
      );
    }

    function runWith(script: string, args: string[]): Run {
      const result = spawnSync(script, args, { cwd: sandbox, encoding: "utf8" });
      return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
    }

    it("前の版が置いた記録でも、token で見つけて返せる", () => {
      const older = olderVersion();
      const held = runWith(older, ["acquire", "worker", stampFor("worker")]);
      expect(held.status, held.stderr).toBe(0);

      const released = runWith(SCRIPT, ["release", "worker", held.stdout.trim()]);

      expect(released.status, released.stderr).toBe(0);
    });

    it("前の版が持っている lease は、いまの版の acquire にも見える", () => {
      // **返せるようにしただけでは、片側しか塞げていない** (#291)。
      // **名前が変わった直後、`acquire` は新しい名前で「空いている」と読む**
      // ——**まだ返していない周回がいるのに、もう 1 つ取れる**。**同じ作業場で
      // checkout と commit が並行する**（#68 の形）——**直列化そのものが、
      // その瞬間だけ成り立たない。**
      const older = olderVersion();
      expect(runWith(older, ["acquire", "worker", stampFor("worker")]).status).toBe(0);

      const second = runWith(SCRIPT, ["acquire", "worker", stampFor("worker")]);

      expect(second.status, "同じ作業場で 2 つ目の周回が通ってしまう").toBe(1);
    });

    it("前の版の記録が期限切れなら、これまでどおり引き継ぐ", () => {
      // **走っている周回を止めるのが目的**であって、**落ちた周回の跡で止まるのは
      // 別の壊れ方**である（**引き継げなくなると、その作業場は二度と動けない**）
      const older = olderVersion();
      expect(
        runWith(older, ["acquire", "worker", stampFor("worker")]).status,
        "前の版で取れていない",
      ).toBe(0);
      ageRecords();

      const second = runWith(SCRIPT, ["acquire", "worker", stampFor("worker")]);

      expect(second.status, second.stderr).toBe(0);
      expect(second.stderr, "引き継いだことが出ていない").toMatch(/期限切れ|引き継/);
    });

    it("引き継いだときも、見つけた記録を消さない", () => {
      // **acquire は返す口ではない** (#291)。**跡を消すと、前の版の周回が返しに来たとき
      // 「誰も持っていません」に落ちる**——**#290 で塞いだ側が、こちらから開く**。
      //
      // **期限切れのほうで見る。** **走っている記録は消しようがない**（取れずに終わる）
      // ——**消したくなるのは引き継ぐ側**である（**実際、生きている記録だけを見ていた
      // 版では、消す変異が生き残った**）
      const older = olderVersion();
      expect(runWith(older, ["acquire", "worker", stampFor("worker")]).status).toBe(0);
      const before = leaseRecords();
      ageRecords();

      expect(runWith(SCRIPT, ["acquire", "worker", stampFor("worker")]).status).toBe(0);

      expect(leaseRecords(), `前の版の記録が消えている: ${before.join(", ")}`).toEqual(
        expect.arrayContaining(before),
      );
    });

    it("別の作業場の記録では止まらない（名前が違っていても）", () => {
      // **worker の lease は作業場ごと**である (#98)。**名前で引けないぶんを走査で
      // 補うと、別の作業場の記録まで見えてしまう**——**2 人目が走っているだけで
      // 1 人目が取れなくなる**（**既存の試験がこれを捕まえた**）。
      //
      // **持ち主は記録の中に書いてある**（3 行目の作業場）ので、**そこで見分ける。**
      expect(
        spawnSync("git", ["-C", sandbox, "commit", "--allow-empty", "--quiet", "-m", "init"], {
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@e",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@e",
          },
        }).status,
      ).toBe(0);
      const other = join(sandbox, "second");
      expect(spawnSync("git", ["-C", sandbox, "worktree", "add", "--detach", other]).status).toBe(
        0,
      );
      const older = olderVersion();
      const held = spawnSync(older, ["acquire", "worker", stampFor("worker")], {
        cwd: other,
        encoding: "utf8",
      });
      expect(held.status, held.stderr).toBe(0);

      const mine = runWith(SCRIPT, ["acquire", "worker", stampFor("worker")]);

      expect(mine.status, `別の作業場が走っているだけで取れない: ${mine.stderr}`).toBe(0);
    });

    it("master の acquire は、worker の記録で止まらない", () => {
      // **役ごとの前方一致に閉じる**（この PR で `release` に入れた形と同じ）——
      // **役が違えば、走っていても関係が無い**
      const older = olderVersion();
      expect(runWith(older, ["acquire", "worker", stampFor("worker")]).status).toBe(0);

      const master = runWith(SCRIPT, ["acquire", "master", stampFor("master")]);

      expect(master.status, master.stderr).toBe(0);
    });

    it("パスを畳んでいた版の記録でも返せる", () => {
      // **残っている名前は 3 通りある** (#290 のレビュー)。**いちばん古い版は
      // `worker` の直後が `_` で、`worker-` では拾えない**——**自分で「3 通り」と
      // 書いておきながら、走査は 2 通りしか見ていなかった**（`AGENTS.md` §5
      // 「変えた側ではなく残る側を数える」。**残る側は自分の diff に出てこない**）
      const older = olderVersion('lease_scope="worker${toplevel//\\//_}"');
      const held = runWith(older, ["acquire", "worker", stampFor("worker")]);
      expect(held.status, held.stderr).toBe(0);
      expect(leaseRecords().join(","), "`_` で始まる名前になっていない").toMatch(
        /valence-loop-lease-worker_/,
      );

      const released = runWith(SCRIPT, ["release", "worker", held.stdout.trim()]);

      expect(released.status, released.stderr).toBe(0);
      expect(leaseRecords(), "前の版の記録が残っている").toHaveLength(0);
    });

    it("master の release は、worker の記録を触らない", () => {
      // **役を取り違えて打つと、別の役の直列化が解ける** (#290 のレビュー)。
      // **走査は自分の役のぶんだけ**である——**`release master <worker の token>` が
      // worker の lease を消して exit 0 になり、しかも「master の lease」と名乗っていた**
      const held = runWith(SCRIPT, ["acquire", "worker", stampFor("worker")]);
      expect(held.status, held.stderr).toBe(0);

      const released = runWith(SCRIPT, ["release", "master", held.stdout.trim()]);

      expect(released.status, "worker の lease を master として返せてしまう").not.toBe(0);
      expect(leaseRecords(), "worker の記録が消えている").toHaveLength(1);
    });

    it("名前が変わっていたことを、黙って通さない", () => {
      // **返せるだけでは足りない。** **名前が変わったことは、次に同じことを起こす**
      // ——**気づけなければ、記録は溜まり続ける**（実物に 3 通り残っている）
      const older = olderVersion();
      const held = runWith(older, ["acquire", "worker", stampFor("worker")]);

      const released = runWith(SCRIPT, ["release", "worker", held.stdout.trim()]);

      expect(released.stderr, "名前が変わったことが出ていない").toMatch(/名前/);
    });

    it("返したら、前の版の記録も残さない", () => {
      // **消すのは「自分が取った記録」である。** **残すと、次の周回から
      // 「別の周回が走っている」に見える**——**引き継ぎの窓が開きっぱなしになる**
      const older = olderVersion();
      const held = runWith(older, ["acquire", "worker", stampFor("worker")]);

      expect(runWith(SCRIPT, ["release", "worker", held.stdout.trim()]).status).toBe(0);

      const left = readdirSync(join(sandbox, ".git")).filter(
        (entry) => entry.startsWith("valence-loop-lease-worker") && !entry.endsWith(".lock"),
      );
      expect(left, `記録が残っている: ${left.join(", ")}`).toHaveLength(0);
    });

    it("他人の token では返せないし、名前が変わったとも言わない", () => {
      // **token は資格である** (#260 と同じ線)。**名前で引けないからといって、
      // 走査した先の記録を誰にでも返させない**——**直列化そのものが崩れる**。
      //
      // **終了コードだけを見ない** (実際に変異が生き残った)。**token を見ずに
      // 乗り換えても、下の突き合わせが「別の周回が持っています」で弾く**ので、
      // **合否は変わらない**——**変わるのは、無関係な記録について
      // 「名前が変わっています」と言い出すこと**である。**誤った案内は、
      // 次に読む人を間違った方向へ走らせる。**
      const older = olderVersion();
      expect(runWith(older, ["acquire", "worker", stampFor("worker")]).status).toBe(0);

      const released = runWith(SCRIPT, ["release", "worker", "deadbeefdeadbeef"]);

      expect(released.status, "他人の token で返せてしまう").not.toBe(0);
      expect(released.stderr, "無関係な記録を、この token のものだと言っている").not.toMatch(
        /名前/,
      );
    });
  });
});
