import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
    git("init", "--quiet", ".");
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
