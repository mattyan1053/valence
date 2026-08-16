import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { procedureText } from "./procedure-doc";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/** その節の bash ブロック（**打つところで見る**）。 */
function blocks(text: string): string[] {
  return text
    .split("```bash")
    .slice(1)
    .map((chunk) => chunk.split("```")[0] ?? "");
}

/**
 * 昇格候補を取るブロックを、偽の `gh` で走らせる。
 *
 * **「書いてある」ではなく「走る」を見る**（`loop/fixup-limit-basis.test.ts` と同じ形）。
 * **散文に「`waiting-condition` は数に入れない」と書いても、打つコマンドが label を
 * 取っていなければ、実行する側には判別する材料が無い**——**実際にそうなっていた**
 * （#313 のレビュー。**出口の判定は正しいのに、人が読んで実行するほうだけが壊れていた**）。
 */
function runFetch(): { status: number; stdout: string; stderr: string } {
  const [block = ""] = blocks(
    procedureText("master").split("## 6. 着手順を決める")[1] ?? "",
  ).filter((chunk) => chunk.includes("--label backlog"));
  const workspace = mkdtempSync(join(tmpdir(), "promotable-"));
  try {
    const stub = join(workspace, "stub");
    mkdirSync(stub, { recursive: true });
    mkdirSync(join(workspace, "bin"), { recursive: true });
    writeFileSync(
      join(stub, "gh"),
      [
        "#!/usr/bin/env bash",
        // **`backlog` を取るときは label まで取ること。** 取っていなければ、
        // **どれが条件待ちかを実行する側が判別できない**
        'if [[ $* == *"--label backlog"* ]]; then',
        '  [[ $* == *"labels"* ]] || { echo "スタブ: backlog の label を取っていない: $*" >&2; exit 1; }',
        `  printf '%s\\n' '[]'`,
        "  exit 0",
        "fi",
        `printf '%s\\n' '[]'`,
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    // **落ちたら停止を積む側も偽物にする**（本物を呼ぶと、試験がカウンタを動かす）
    writeFileSync(
      join(workspace, "bin/loop-stall"),
      ["#!/usr/bin/env bash", 'echo "stall $*" >&2', "exit 0", ""].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync("bash", ["-c", block], {
      cwd: workspace,
      encoding: "utf8",
      env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
    });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

/** 見出しで区切った 1 節（**節の外の散文で条件が満たされない**ようにする）。 */
function section(heading: string): string {
  const after = procedureText("master").split(heading)[1] ?? "";
  return after.split(/\n#{2,4} /)[0] ?? "";
}

/**
 * 「いま渡せないもの」を、状態として残すこと（#312）。
 *
 * **`backlog` に「いま渡せないもの」しか残っていない周回**は、**ループが正常に動いた
 * まま、空転を 1 度も記録せずに止まる**——**`no-work` は `backlog` が 0 件のときだけ**
 * 積まれ、**出口は「昇格の番」と言い続ける**。**3 周で人を呼ぶ仕掛けが、
 * 呼ぶべき場面で働かない**（#47 で塞いだ形が、別の場所に開いていた）。
 *
 * **判定はスクリプトが持つ**（`bin/loop-handoff`）。**ここで見るのは、その判定が
 * 読む印を、master が実際に付けるか**である——**置く側と読む側は 1 組**で、
 * **付ける側が無ければ、判定は永久に「全部渡せる」と答える。**
 */
describe("いま昇格できない backlog", () => {
  it("判定に使う印を、master が付ける", () => {
    // **master の記憶に置かない。** **セッションが落ちれば消える**ので、
    // **次の周回は同じ判断をやり直すだけ**になり、どこにも出てこない
    const doc = procedureText("master");

    expect(doc, "条件待ちの印を付ける手が無い").toMatch(/--add-label waiting-condition/);
    expect(doc, "条件が来たときに外す手が無い").toMatch(/--remove-label waiting-condition/);
  });

  it("印を付けたら、理由も残す", () => {
    // **label だけでは「何を待っているか」が分からない**——**次に見る人（人間を含む）は、
    // 条件が来たかどうかを判断できない**
    expect(section("### 昇格できないものを、待たせておく"), "理由を残すと書いていない").toMatch(
      /gh issue comment/,
    );
  });

  it("その印を、出口の判定が読んでいる", () => {
    // **付ける側と読む側は 1 組である。** **読まないなら、付けていないのと同じ**
    const handoff = read("bin/loop-handoff");

    expect(handoff, "出口が印を読んでいない").toContain('labels:["backlog","waiting-condition"]');
    expect(handoff, "件数だけで昇格の番を決めている").toMatch(/promotable > 0 && ready == 0/);
  });

  it("印は `./task loop:setup` が用意する", () => {
    // **存在しない label を書いても GitHub は黙って落とす**——
    // **付けたつもりのまま、どの一覧にも現れない**（`loop/labels.test.ts` と同じ理由）
    const match = read("task").match(/for label in ([^;]+); do/);

    expect(match?.[1]?.split(/\s+/), "label が用意されていない").toContain("waiting-condition");
  });

  it("`blocked` の意味を広げていない", () => {
    // **`blocked` は「人の判断待ち」**（`loop/README.md`）で、
    // **「条件がまだ来ていない」は人と関係ない**——**名前が測っているものとずれる**のが、
    // このループで何度も直している形である
    const readme = read("loop/README.md");
    const blocked = readme.split("\n").filter((line) => /^\|\s*`blocked`/.test(line))[0] ?? "";

    expect(blocked, "blocked の説明が条件待ちへ広がっている").not.toMatch(/条件/);
  });

  it("昇格候補を取るときに、印まで取っている", () => {
    // **散文だけでは効かない** (#313 のレビュー。優先度 1)。**「`waiting-condition` は
    // 数に入れない」と書いても、取得が `number,title,body` のままなら、
    // 実行する側にはどれが条件待ちか分からない**——**条件待ちの Issue を `ready` へ
    // 上げられる。** **出口の判定は正しく配線されていた**ので、
    // **壊れていたのは人が読んで実行するほうだけ**である
    // **終了コードでは見ない。** **取得が落ちるとブロックは `bin/loop-stall` を通って
    // `exit` する**ので、**最後に走ったコマンドの成否がそのまま出る**——**落ちた周回でも
    // 0 になりうる**（**この本を最初に書いたとき、実際に空振りしていた**）。
    // **最後まで走ったときにだけ出るもの**を見る
    const result = runFetch();

    expect(result.stdout, `候補の取得が label を取っていない: ${result.stderr}`).toContain(
      "backlog:",
    );
  });

  it("人へ届く説明が、いまの条件と揃っている", () => {
    // **`--list` は、止まった人が読む唯一の説明**である (#313 のレビュー。優先度 2)。
    // **古い条件のままだと、`backlog` が 1 件あるのに「作業が無い」と言っているように
    // 見え**、**調べる側が「見落とし」を疑って時間を使う**
    const listed = execFileSync(join(REPO_ROOT, "bin/loop-stall"), ["--list"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    const noWork = listed.split("\n").filter((line) => line.includes("no-work"))[0] ?? "";

    expect(noWork.trimStart(), "識別子そのものが変わっている").toMatch(/^no-work\s/);
    expect(noWork, "説明が古い条件のままである").toMatch(/昇格できる/);
    expect(read("loop/README.md"), "README が古い条件のままである").toMatch(
      /昇格できる `backlog`|昇格できるものが/,
    );
  });

  it("作業が尽きた判定が、昇格できるかで決まっている", () => {
    // **`backlog` が 0 件かどうかでは決まらない** (#312)。**渡せるものが無い周回は、
    // `backlog` に何件残っていても `no-work` である**
    const ended = section("### 作業が尽きたとき");

    expect(ended, "尽きた条件が backlog の件数のままである").toMatch(/waiting-condition/);
  });

  it("その識別子が、一覧にある", () => {
    // **一覧に無い識別子は弾かれる**（`bin/loop-stall` は書式まで見る）
    const listed = execFileSync(join(REPO_ROOT, "bin/loop-stall"), ["--list"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    expect(listed).toContain("no-work");
  });
});
