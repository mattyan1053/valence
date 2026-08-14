/**
 * **配られた手順書が、ディスクより古いことがある**（#241）。
 *
 * **#227 の仕組みでは見えない。** **`bin/loop-procedure-changed` が比べているのは
 * git の commit** で、**「いま読んでいるテキストが何版か」は見ていない**——
 * **切り替えたあとは正しく「変わっていない」と答える**ので、**赤くならない。**
 *
 * **配る側は直せない**（リポジトリの外）ので、**気づけるようにする。**
 * **検出は「読んだ側が申告する」形になる**——**手順書の中に版の印を置き、
 * 読んだ印をディスクの印と突き合わせる。**
 *
 * **印が無い版が配られたら「古い」と読む**——**印を入れる前の版がそれ**である。
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
const SCRIPT = join(REPO_ROOT, "bin/loop-procedure-stamp");
const ROLES = ["worker", "master"] as const;

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function run(args: string[], cwd: string = REPO_ROOT): { status: number; stdout: string } {
  const result = spawnSync(SCRIPT, args, { cwd, encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout.trim() };
}

/**
 * 手順書を書き換えた**チェックアウトの写し**を作る。**実物を触らない。**
 *
 * **スクリプトの隣から手順書を辿る**ので、**cwd を変えるだけでは足りない**
 * ——**スクリプトごと写す**（実物と同じ置き方にする）。
 */
function checkoutWith(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "procedure-stamp-"));
  sandboxes.push(dir);
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, ".claude", "commands"), { recursive: true });
  copyFileSync(SCRIPT, join(dir, "bin", "loop-procedure-stamp"));
  chmodSync(join(dir, "bin", "loop-procedure-stamp"), 0o755);
  writeFileSync(join(dir, ".claude", "commands", "loop-worker.md"), body);
  return join(dir, "bin", "loop-procedure-stamp");
}

function runIn(script: string, args: string[]): { status: number; stdout: string } {
  const result = spawnSync(script, args, { encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout.trim() };
}

describe("配られた手順書の版を、ディスクと突き合わせる", () => {
  for (const role of ROLES) {
    it(`${role} の手順書が、自分の印を持っている`, () => {
      // **印が古いまま置かれると、正しい版を配られた周回まで止まる**ので、
      // **`./task check` で落とす**——**印は手で書くが、合っているかは機械が見る**
      const stamp = run([role]);

      expect(stamp.status, "印を計算できない").toBe(0);
      expect(stamp.stdout, "印が空である").not.toBe("");

      const body = readFileSync(join(REPO_ROOT, `.claude/commands/loop-${role}.md`), "utf8");
      expect(body, "手順書に書いてある印が、中身と合っていない").toContain(
        `<!-- 版: ${stamp.stdout} -->`,
      );
    });

    it(`${role} の印を渡すと、そのまま通る`, () => {
      // **正常な周回で鳴らない**（完了条件）
      const stamp = run([role]);

      expect(run([role, stamp.stdout]).status, "正しい印で止めている").toBe(0);
    });
  }

  it("古い印を渡したら、止まる側へ倒れる", () => {
    // **これが本題。** **配られたテキストが古いと、印も古い**
    expect(run(["worker", "0123456789ab"]).status).toBe(1);
  });

  it("印が無くても、止まる側へ倒れる", () => {
    // **印を入れる前の版が配られた形**——**「読めない」ではなく「古い」**である
    expect(run(["worker", ""]).status).toBe(1);
    expect(run(["worker", "なし"]).status).toBe(1);
  });

  it("ディスクの手順書に印が無ければ、判定できないと言う", () => {
    // **こちらは「古い」ではない**——**突き合わせる相手が無い**
    const script = checkoutWith("# 手順書\n\n印の無い版である。\n");

    expect(runIn(script, ["worker", "0123456789ab"]).status).toBe(2);
  });

  it("印は中身から決まる（手で書いた値を信じない）", () => {
    // **印だけ書き換えても、中身が違えば違う印になる**——
    // **「印を足したが、中身と関係ない」を作らない**
    const stamp = run(["worker"]);
    const script = checkoutWith(`<!-- 版: ${stamp.stdout} -->\n\n# 別の中身\n`);

    expect(runIn(script, ["worker"]).stdout, "中身が違うのに同じ印になる").not.toBe(stamp.stdout);
  });

  it("使い方の誤りは、古いと混ぜない", () => {
    expect(run([]).status).toBe(2);
    expect(run(["それ以外の役"]).status).toBe(2);
    expect(run(["worker", "印", "余計な引数"]).status).toBe(2);
  });
});

describe("ずれたときの行き先が、手順書に書いてある", () => {
  for (const role of ROLES) {
    it(`${role} の手順書が、入口で印を渡している`, () => {
      const body = readFileSync(join(REPO_ROOT, `.claude/commands/loop-${role}.md`), "utf8");

      // **入口で受ける** (#243 のレビュー)。**手順書の側に「印を突き合わせよ」と
      // 書いても、古い版にはその行が無い**——**`acquire` に渡す形にする**
      expect(body, "入口で印を渡していない").toMatch(
        new RegExp(`bin/loop-lease acquire ${role} "`),
      );
      // **2 回目の行き先まで書く**（#241 の完了条件）——**呼び直しても古い版が
      // 来たのが今回**である
      expect(body, "2 回目の行き先が書いていない").toContain("procedure-stale");

      // **この経路で `--reset` を呼ばない** (#243 のレビュー)。**消すと、次の周回が
      // 積んだぶんも一緒に消える**——**毎周回 1 に戻り、3 周へ永久に届かない**
      // （**入れた escalation を、同じ段落の 1 行が消していた**）。
      const from = body.indexOf("印がずれていたら、`acquire` は exit 3 で止まる");
      const stale = body.indexOf("procedure-stale", from);
      expect(from, "印がずれたときの段落が無い").toBeGreaterThanOrEqual(0);
      const section = body.slice(from, stale);
      // **「消す」形が残っていないこと**（**「呼ばない」と書いてある文とは別**）
      expect(section, "捨てる前にカウンタを消している（3 周に届かない）").not.toMatch(
        /--reset` *→/,
      );
      expect(section, "消さない理由が書いていない").toMatch(/--reset` を呼ばない/);
    });
  }

  describe("止まった状態から出る道", () => {
    /**
     * **印を変える PR を出した作業場は、次の周回から入れなくなる**（#262）。
     *
     * **その PR を直す周回にも入れない**ので、**PR は自分自身で詰む**——
     * **レビュー指摘が残っていても手が動かせず、マージもされないので、印は違ったまま**である。
     * **#261 で実測した**（`bin/loop-stall procedure-stale` が積まれ、3 周で `loop/STOP`）。
     *
     * **止まること自体は正しい。** **配られた手順書とディスクのスクリプトが噛み合って
     * いないのは事実**で、**その組み合わせで走らせてはいけない。**
     * **問題は「止まった状態から出る道が無いこと」**である（AGENTS.md §5。#184）。
     *
     * **道はある**——**その PR の枝へ入れば、手順書もスクリプトも揃う。**
     * **検査を迂回していない**（**噛み合っている状態を実際に作っている**）。
     * **足りなかったのは、その順序がどこにも書かれていないこと**である。
     */
    function worker(): string {
      return readFileSync(join(REPO_ROOT, ".claude/commands/loop-worker.md"), "utf8");
    }

    /** 印がずれたときの段落。**入り方が書かれるべきところ**である。 */
    function staleSection(): string {
      const body = worker();
      const from = body.indexOf("印がずれていたら、`acquire` は exit 3 で止まる");
      expect(from, "印がずれたときの段落が無い").toBeGreaterThanOrEqual(0);
      return body.slice(from).split("\n## ")[0] ?? "";
    }

    it("自分の PR の枝へ入って取り直す、と書いてある", () => {
      // **`acquire` は周回の冒頭で、checkout はそれより後**なので、
      // **普通に周回を始めるかぎり、この順序へは到達しない**
      const section = staleSection();

      expect(section, "枝へ入る手が書いていない").toContain("gh pr checkout --detach");
      expect(section, "入る前に PR を取っていない").toContain("bin/loop-claim pr");
    });

    it("素通りではないと書いてある（揃わなければ、また止まる）", () => {
      // **「新しければ通す」で直さない**（Issue の「やらないこと」）。
      // **方向を見て素通りさせると、まさに噛み合わない組み合わせで走る**
      expect(staleSection(), "揃わなければ止まることが書いていない").toMatch(
        /揃わなければ|揃っていなければ/,
      );
    });

    it("その周回は `origin/main` へ移らない、と書いてある", () => {
      // **入った先は PR の枝**である。**そのまま 1.1 で `origin/main` へ移すと、
      // `bin/loop-procedure-changed` が入れ替わりを見つけて、その周回を捨てる**——
      // **入れたばかりの道が、次の行で閉じる。**
      expect(staleSection(), "同期で枝から降ろされることに触れていない").toContain("--fetch-only");
    });

    it("木を触る前に、原子的に押さえると書いてある", () => {
      // **読むだけの確認では足りない**（#268 のレビュー）。**`held` を見てから
      // `gh pr checkout` を打つまでの間に、別の周回が普通の `acquire` を通せる**——
      // **その直後に checkout すると、走っている周回の HEAD と作業ツリーを入れ替える**
      // （#68 の形）。**確かめて空けたままにせず、その場で決着させる。**
      const section = staleSection();

      expect(section, "原子的に押さえていない").toContain("bin/loop-lease recover worker");
      expect(section, "読むだけの確認に戻っている").not.toContain("bin/loop-lease held worker");
    });

    it("押さえたあと、揃ったかを確かめると書いてある", () => {
      // **押さえることは、進んでよいという意味ではない。**
      // **判定は `bin/loop-procedure-stamp` が 1 箇所で持つ**
      expect(staleSection(), "揃ったかを確かめていない").toContain(
        "bin/loop-procedure-stamp worker",
      );
    });

    it("揃わなかったら、押さえたぶんを返すと書いてある", () => {
      // **返さずに終わると、この作業場は期限が切れるまで動けない**——
      // **入れた道が、次の周回を閉じ込める**
      expect(staleSection(), "押さえたぶんを返していない").toContain(
        "bin/loop-lease release worker",
      );
    });

    it("比較先を空にしない、と書いてある", () => {
      // **`--fetch-only` は SHA を出さない**（#268 のレビュー）。**空のまま渡すと、
      // `${2:-HEAD}` で HEAD に既定されて「HEAD と HEAD を比べる」になる**——
      // **答えは正しいが、比べていない。** **黙って既定に落ちる形を残さない。**
      const section = staleSection();
      const fetchOnly = section.indexOf("--fetch-only");

      expect(fetchOnly, "--fetch-only に触れていない").toBeGreaterThanOrEqual(0);
      expect(section.slice(fetchOnly), "比較先を明示していない").toContain("git rev-parse HEAD");
    });
  });

  for (const role of ROLES) {
    it(`${role} の打ち切りは、同期の失敗のぶんだけ消す`, () => {
      // **前へ進んだ証拠は「HEAD が動いた」＝同期が成功したこと**なので、
      // **消せるのもそのぶんだけ**である（#266）。**全部消すと、呼び直した先が
      // 印ずれで積んだぶんまで次の周回が消し**、**count は 1 を超えない**——
      // **1.0 が名指しで禁じている害が、隣の経路で起きていた。**
      //
      // **見るのは 1.1 の節だけ**である。**マージのあとに捨てる経路は別**で、
      // **あちらの証拠は「マージが入った」**——**ループ全体が前へ進んでいる。**
      const body = readFileSync(join(REPO_ROOT, `.claude/commands/loop-${role}.md`), "utf8");
      const from = body.indexOf("bin/loop-procedure-changed --role");
      expect(from, "1.1 の節が見つからない").toBeGreaterThanOrEqual(0);
      const section = body.slice(from).split("\n## ")[0] ?? "";

      expect(section, "打ち切りの --reset に消す対象が書いていない").toContain(
        "bin/loop-stall --reset main-sync-failed",
      );
      expect(section, "1.1 に、全部消す --reset が残っている").not.toMatch(
        /bin\/loop-stall --reset\n/,
      );
    });
  }

  for (const role of ROLES) {
    it(`${role} は、--reset が落ちたときの行き先を書いている`, () => {
      // **手順書は `--reset` の直後で終わっていた**（#270）ので、**読む側は成功した
      // ものとして進む**——**害は「消えなかったカウンタで、次の周回が古い数から続ける」**。
      // **#266 が塞いだ「消しすぎ」の裏側**である。
      //
      // **落ちる道は実在する**（ロックを取れない / 設定の誤り / 2 引数を知らない版が
      // ディスクにある——**worker が #269 の周回で実際に受けた**）。
      const body = readFileSync(join(REPO_ROOT, `.claude/commands/loop-${role}.md`), "utf8");
      const from = body.indexOf("bin/loop-procedure-changed --role");
      expect(from, "1.1 の節が見つからない").toBeGreaterThanOrEqual(0);
      const section = body.slice(from).split("\n## ")[0] ?? "";

      expect(section, "落ちたときの行き先が書いていない").toMatch(/落ちても|失敗しても/);
      // **止めない** (#270 の「やらないこと」)。**前へ進んだあとに止めると、
      // 進んでいるのに 3 周で全ループが止まる**
      expect(section, "止めないことが書いていない").toMatch(/止めない/);
    });
  }

  it("マージのあとに捨てる経路は、参照ではなく実際にしていることを書く", () => {
    // **`#266` が参照される側を変えたのに、参照する側を数えていなかった**（#270）。
    // **1.1 はいま `main-sync-failed` だけを消す**ので、**「1.1 と同じ」に従った読み手は
    // 対象つきを打ち**、**マージのあとに消すべきほかの記録が残る。**
    //
    // **参照をやめれば、次に 1.1 が変わっても壊れない**（AGENTS.md §5）。
    // **範囲を絞る**（#272 のレビュー）。**1.1 にも「全部消すと」がある**ので、
    // **手順書全体で見ると、マージ後の経路から指示を消しても通ってしまう。**
    const body = readFileSync(join(REPO_ROOT, ".claude/commands/loop-master.md"), "utf8");
    // **1.1 と同じ錨は使えない**——**`bin/loop-procedure-changed --role` は
    // 1.1 にも 3.1 にもあり、`indexOf` は 1.1 を先に見つける。**
    // **切り方も `\n### `**（`\n## ` だと次の `## 4.` まで飲み込む）。
    const from = body.indexOf("### exit 0 — マージする");
    expect(from, "マージの節が見つからない").toBeGreaterThanOrEqual(0);
    const section = body.slice(from).split("\n### ")[0] ?? "";

    expect(body, "参照の言い回しが残っている").not.toMatch(/捨てるなら 1\.1 と同じ/);
    // **語形まで合わせる。** **全体で見ていたときは、1.1 の「全部消すと」に
    // 当たって通っていた**——**節を絞ると、この経路には 1 文字も無いことが出る。**
    expect(section, "その場でしていることが書いていない").toMatch(/カウンタを全部消して/);
    // **対象なしであること**——**対象つきを打つと、消すべき記録が残る**
    expect(section, "対象なしの --reset が書いていない").toMatch(/bin\/loop-stall --reset(?![ -])/);
  });

  it("止まる先が、識別子の一覧にある", () => {
    // **識別子を勝手に作らない。** 一覧の正は `bin/loop-stall --list` である
    const listed = spawnSync(join(REPO_ROOT, "bin/loop-stall"), ["--list"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout, "procedure-stale が一覧に無い").toContain("procedure-stale");
  });
});
