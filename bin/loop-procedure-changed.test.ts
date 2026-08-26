import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { holdLock } from "../test/held-lock";

const SCRIPT = fileURLToPath(new URL("./loop-procedure-changed", import.meta.url));

type Run = { status: number; stdout: string; stderr: string };

describe("bin/loop-procedure-changed", () => {
  let repo: string;

  function git(...args: string[]): void {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  }

  /** 使い捨ての git リポジトリに commit を作る。**実リポジトリの履歴は触らない。** */
  function commit(path: string, contents: string): string {
    mkdirSync(join(repo, dirname(path)), { recursive: true });
    writeFileSync(join(repo, path), contents);
    git("add", "-A");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", `edit ${path}`);
    return spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
  }

  /** そのまま渡す。**役を書かない呼び方**も試せるようにしておく。 */
  function runRaw(...args: string[]): Run {
    const result = spawnSync(SCRIPT, args, { cwd: repo, encoding: "utf8" });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  /**
   * **役は必須**なので、書いていなければ master を補う。
   *
   * **ここで補うのは、この試験が見たいのが役の分かれ方ではなく判定そのもの**だから
   * である——**役を書かない呼び方は `runRaw` で別に試す。**
   */
  function run(...args: string[]): Run {
    return args[0] === "--role" ? runRaw(...args) : runRaw("--role", "master", ...args);
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "loop-procedure-"));
    // **既定の枝名は環境で変わる。** **`main` を前提にする試験があるので、ここで固定する**
    git("init", "--quiet", "-b", "main", ".");
    commit("README.md", "初期\n");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it.each([
    ".claude/commands/loop-master.md",
    "bin/loop-gate",
    "task",
    "loop/README.md",
    // **master は共通指示も読む。** 判断基準とセキュリティ規則がここにある
    "AGENTS.md",
  ])("%s が変わったら、変わったと判定する", (path) => {
    // **master が周回中に読む・実行するもの。** 入れ替わったまま走ると、
    // いま読んでいる手順書と、これから実行する手順書が食い違う
    const before = commit("src/other.ts", "前\n");
    commit(path, "後\n");

    expect(run(before).status).toBe(0);
  });

  it("対象外のファイルだけなら、変わっていないと判定する", () => {
    // **これが本題。** マージのたびに周回を捨てていたのは、`src/` しか触らない
    // PR でも「HEAD が動いた」で打ち切っていたため
    const before = commit("bin/loop-gate", "前\n");
    commit("src/domain/graph/dependency-graph.ts", "後\n");

    expect(run(before).status).toBe(1);
  });

  it("bin の試験だけなら、変わっていないと判定する", () => {
    // **master は試験ファイルを実行しない。** `src/` しか触らない PR で捨てないのと
    // 同じ理由で、ここも捨てない——**試験だけを直した PR の直後に、毎回 1 周が空振りする**
    // （実測で 2 回。#152 / #155 のマージ直後）。
    //
    // **空振りは 1 周の遅れでは終わらない。** 打ち切ると呼び直すので、
    // **「新しい版が読み込まれる保証は無い」（実測 2 回中 1 回）に毎回賭ける**
    const before = commit("bin/loop-gate", "前\n");
    commit("bin/loop-stall.test.ts", "後\n");

    expect(run(before).status).toBe(1);
  });

  it("bin の実体が変わったら、試験も一緒でも、変わったと判定する", () => {
    // **判定を緩めて「変わっていない」に倒さない。**
    // **master が古いスクリプトで走り続けるほうが、空振りより危険**である（#93）
    const before = commit("src/a.ts", "前\n");
    mkdirSync(join(repo, "bin"), { recursive: true });
    writeFileSync(join(repo, "bin/loop-gate"), "後\n");
    writeFileSync(join(repo, "bin/loop-gate.test.ts"), "後\n");
    git("add", "-A");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "本体と試験");

    expect(run(before).status).toBe(0);
  });

  describe("捨てた周回を、あとから数えられるようにする（#400）", () => {
    /** 積まれた記録の行。**読み口はこのスクリプトが持つ。** */
    function churnLog(): string[] {
      const listed = runRaw("--role", "master", "--churn-log");
      return listed.stdout.split("\n").filter(Boolean);
    }

    it("入れ替わりを見つけたら、何が入れ替わったかを残す", () => {
      // **`procedure-churn` は「捨てた」という事実だけを数える** (#367)。**中身が
      // 違うものが同じ名前で数えられている**——**他人が入れ替えたものを踏んだ**のと、
      // **自分が撒いた種**（**自分が直した `task` の 1 行で、自分の次の周回が捨てられる**）
      // が混ざると、**「続くと実装が進まない」の判断が濁る。**
      const before = commit("src/a.ts", "前\n");
      const after = commit("task", "後\n");

      expect(run(before).status, "入れ替わりを見つけていない").toBe(0);

      const lines = churnLog();
      expect(lines.length, "捨てた周回が残っていない").toBe(1);
      expect(lines[0], "何が入れ替わったかが無い").toContain("task");
      expect(lines[0], "どの役かが無い").toContain("master");
      expect(lines[0], "どの版からどの版へかが無い").toContain(`${before}..${after}`);
    });

    it("変わっていない周回は、残さない", () => {
      // **数えたいのは「捨てた周回」**である——**通った周回まで積むと、
      // 記録は「毎周回 1 行」になり、押し出しで本物が消える**（#401 の向き）
      const before = commit("bin/loop-gate", "前\n");
      commit("src/only.ts", "後\n");

      expect(run(before).status, "変わったと判定している").toBe(1);

      expect(churnLog(), "捨てていない周回を積んでいる").toEqual([]);
    });

    it("問い合わせでは積まない", () => {
      // **`--list` も `--churn-log` も読むだけ**である（#390 と同じ向き）
      const before = commit("task", "前\n");
      commit("task", "後\n");
      expect(run(before).status).toBe(0);

      runRaw("--role", "master", "--list");
      churnLog();

      expect(churnLog().length, "尋ねるたびに積んでいる").toBe(1);
    });

    it("記録が無ければ、記録が無いと答える", () => {
      // **「無い」と「読めない」を混ぜない**（`--verdict` / `--durations` と同じ語彙）
      expect(runRaw("--role", "master", "--churn-log").status).toBe(4);
    });

    it("記録が伸び続けない", () => {
      const before = commit("task", "前\n");
      for (let index = 0; index < 12; index += 1) {
        commit("task", `後 ${index}\n`);
        expect(run(before).status).toBe(0);
      }

      expect(churnLog().length, "捨てるたびに伸びている").toBeLessThanOrEqual(10);
    });

    it("記録が書けなくても、周回は止めない", () => {
      // **#270 の向き**——**測るための記録が落ちても、捨てる判断は返す**
      const before = commit("src/a.ts", "前\n");
      commit("task", "後\n");
      // **積む先の錠を、開けない形にする**（**書けなければ積めない**）
      const lock = join(repo, ".git", "valence-loop-churn.lock");
      writeFileSync(lock, "");
      chmodSync(lock, 0o444);

      const answered = run(before);

      expect(answered.status, "記録できないことで、判定が変わっている").toBe(0);
      expect(answered.stdout, "捨てた理由が出ていない").toContain("task");
      // **語を名指しする**——**別の WARN（lease の確認など）で満たさない**
      expect(answered.stderr, "書けなかったことを黙っている").toMatch(
        /\[WARN\] 捨てた周回を記録できません/,
      );
    });

    it("握られていて積めなくても、黙らない", () => {
      // **開けない錠と、握られている錠は別の道である** (#511 のレビュー)。
      // **開けない錠では `exec` そのものが失敗する**ので、**上の試験は通る**——
      // **握られている側は、`exec` が成功したあとで待ちに入る**。
      //
      // **`2>/dev/null` を `exec` に直接付けていると、そこから先の標準エラーが
      // 丸ごと消える** (#445 と同じ形)——**警告を出したつもりで、何も出ていない。**
      const before = commit("src/a.ts", "前\n");
      commit("task", "後\n");
      const held = holdLock({ dir: repo, lock: join(repo, ".git", "valence-loop-churn.lock") });
      let answered: ReturnType<typeof run>;
      try {
        answered = run(before);
      } finally {
        held.release();
      }

      expect(answered.status, "記録できないことで、判定が変わっている").toBe(0);
      expect(answered.stderr, "握られていたことを黙っている").toMatch(
        /\[WARN\] 捨てた周回を記録できません/,
      );
    });
  });

  it("--list は、除いているものも隠さない", () => {
    // **判定だけ別の場所で例外にすると、`--list` が嘘をつく。**
    // **対象はスクリプトが 1 つ持つ**のがこの仕組みの前提である
    const listed = run("--role", "master", "--list");

    expect(listed.stdout).toContain("bin/");
    expect(listed.stdout).toContain("test.ts");
  });

  it("worker の手順書だけなら、変わっていないと判定する", () => {
    // master が実行するのは master の手順書である。**worker 側の変更で捨てない**
    const before = commit("bin/loop-gate", "前\n");
    commit(".claude/commands/loop-worker.md", "後\n");

    expect(run(before).status).toBe(1);
  });

  it("HEAD と同じなら、変わっていないと判定する", () => {
    const before = commit("bin/loop-gate", "前\n");

    expect(run(before).status).toBe(1);
  });

  it("対象と対象外が混ざっていたら、変わったと判定する", () => {
    // **捨てる側に倒す。** 1 つでも入れ替わっていれば、走らせてはいけない
    const before = commit("src/a.ts", "前\n");
    mkdirSync(join(repo, "bin"), { recursive: true });
    writeFileSync(join(repo, "bin/loop-gate"), "後\n");
    writeFileSync(join(repo, "src/a.ts"), "後\n");
    git("add", "-A");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "mixed");

    expect(run(before).status).toBe(0);
  });

  it("判定できなければ 2 で落ちる", () => {
    // **判定不能を「変わっていない」に倒さない。** 古い手順で走り続けるより止まる
    expect(run("0000000000000000000000000000000000000000").status).toBe(2);
    expect(run().status).toBe(2);
    expect(run("HEAD", "余計な引数").status).toBe(2);
  });

  it("対象の一覧を出せる", () => {
    // **一覧の正はスクリプト 1 箇所。** 手順書に書き写すと、片方だけ直して食い違う
    const listed = run("--role", "master", "--list");

    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain("bin/");
  });

  it("比較先を指定できる", () => {
    // **マージしても手元の HEAD は動かない**（GitHub 側でマージするだけ）。
    // HEAD と比べると必ず「変わっていない」になり、**手順書を変えた PR の直後に
    // 古い手順のまま進む**
    const before = commit("src/a.ts", "前\n");
    const after = commit("bin/loop-gate", "後\n");
    git("checkout", "--quiet", before);

    expect(run(before, after).status).toBe(0);
    expect(run(before).status).toBe(1); // HEAD は before のままなので変わらない
  });

  it("比較先が不正なら 2 で落ちる", () => {
    const before = commit("src/a.ts", "前\n");

    expect(run(before, "0000000000000000000000000000000000000000").status).toBe(2);
  });

  /**
   * **居た場所と、動いた版を混ぜない** (#259)。
   *
   * **PR を checkout した翌周回は、必ず捨てていた。** **前の周回が PR の commit で
   * 終わり、冒頭の同期で `origin/main` へ戻ると、その PR 自身の変更が差分に出る**
   * ——**手順書もスクリプトも何も変わっていないのに**である。
   *
   * **入力は自分で書く側**（§5）——**「PR の commit に居る」状態は、
   * 普通に走らせただけでは作られない。**
   */
  describe("枝の上に居ただけなら、入れ替わったとは言わない", () => {
    /** `main` から枝を伸ばし、その先端（PR の head）を返す。 */
    function branchOffMain(path: string): { main: string; head: string } {
      const main = commit("bin/loop-gate", "main の版\n");
      git("checkout", "--quiet", "-b", "feat/x");
      const head = commit(path, "PR の版\n");
      return { main, head };
    }

    it("PR の commit から main へ戻るだけなら、変わっていない", () => {
      // **これが本題。** **その PR 自身の変更を「入れ替わった」と読んでいた**
      const { main, head } = branchOffMain("bin/loop-gate");

      expect(run(head, main).status, "自分の枝の変更を数えている").toBe(1);
    });

    it("手順書を直している PR でも、同じ", () => {
      // **踏むのはレビュー対応の直後**——**手順書を直す PR ほど往復が続く**
      const { main, head } = branchOffMain(".claude/commands/loop-master.md");

      expect(run(head, main).status).toBe(1);
    });

    it("枝に居る間に main が動いていたら、変わったと言う", () => {
      // **誤検知を消すために、本当の検知まで消さない。** **枝の分かれ目から見て
      // `main` 側に入った変更は、これから実行するものが本当に入れ替わる**
      const { head } = branchOffMain("src/a.ts");
      git("checkout", "--quiet", "main");
      const moved = commit("bin/loop-gate", "main が進んだ\n");

      expect(run(head, moved).status, "main の動きまで見逃している").toBe(0);
    });

    it("枝に居る間に main が動いても、対象外なら変わっていない", () => {
      const { head } = branchOffMain("src/a.ts");
      git("checkout", "--quiet", "main");
      const moved = commit("src/b.ts", "main が進んだ\n");

      expect(run(head, moved).status).toBe(1);
    });

    it("同じ系譜の上なら、これまでどおり比べる", () => {
      // **マージ直後の周回はここを通る。** **`origin/main` は作業場どうしで共有** なので、
      // **もう一方が先に fetch した周回では、`origin/main` を基準にすると
      // 「動いていない」に見える**——**そこを落とさないために、系譜の上では HEAD を使う**
      const before = commit("src/a.ts", "前\n");
      const after = commit("bin/loop-gate", "後\n");

      expect(run(before, after).status).toBe(0);
    });

    it("枝分かれの跡が無ければ、判定できないと言う", () => {
      // **黙って「変わっていない」に倒さない。** **共通の祖先が無いのは、
      // 別のリポジトリを指しているとき**である
      const orphan = spawnSync(
        "bash",
        [
          "-c",
          "git checkout --quiet --orphan lonely && git rm -rfq --cached . " +
            "&& echo x > lonely.txt && git add -A " +
            "&& git -c user.email=t@example.com -c user.name=t commit --quiet -m lonely " +
            "&& git rev-parse HEAD",
        ],
        { cwd: repo, encoding: "utf8" },
      );
      expect(orphan.status, orphan.stderr).toBe(0);

      expect(run(orphan.stdout.trim(), "main").status).toBe(2);
    });
  });

  /**
   * **役ごとに読む手順書が違う** (#227)。**両方を見ると、相手の手順書を直しただけの
   * PR で周回が空振りする**——**その役が実行しないものは、入れ替わっても実行内容を
   * 変えない**（`src/` だけの PR で捨てないのと同じ理由）。
   */
  describe("役ごとの対象", () => {
    it("master を指すと、master の手順書を見る", () => {
      // **既定はもう無い** (#228 のレビュー)。**「既定は master」と書いたままにすると、
      // 次に読む人が「書き忘れは master になるはず」と読む**——**実際は `exit 2`** である
      const listed = run("--role", "master", "--list");

      expect(listed.stdout).toContain(".claude/commands/loop-master.md");
      expect(listed.stdout, "相手の手順書まで見ている").not.toContain(
        ".claude/commands/loop-worker.md",
      );
    });

    it("worker を指すと、worker の手順書を見る", () => {
      const listed = run("--role", "worker", "--list");

      expect(listed.stdout).toContain(".claude/commands/loop-worker.md");
      expect(listed.stdout, "相手の手順書まで見ている").not.toContain(
        ".claude/commands/loop-master.md",
      );
    });

    it("知らない役は受けない", () => {
      // **黙って既定へ倒すと、worker のつもりで master を見る**
      expect(run("--role", "nobody", "HEAD").status).toBe(2);
    });

    it("役だけ書いて中身が無ければ、使い方の誤りにする", () => {
      expect(run("--role").status).toBe(2);
    });

    it("役を書かなければ、判定しない", () => {
      // **既定を持たせない** (#228 のレビュー)。**書き忘れが黙って別の役を見張る**
      // ——**master の手順書を直した PR で worker が空振りし、worker の手順書を
      // 直した PR で捨てない**（**本命の穴**）。**どちらも「それらしい答え」なので
      // 赤くならない。** **`exit 2` なら「1 以外はすべて捨てる」に乗る。**
      expect(runRaw("HEAD").status).toBe(2);
    });

    it("`--list` にも役が要る", () => {
      // **役ごとに一覧が違う**ので、**役を言わずに出せると、どちらか分からない**
      expect(runRaw("--list").status).toBe(2);
    });
  });
});
