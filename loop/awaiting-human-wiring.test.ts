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

/**
 * 人の判断待ちで、ループ全体が止まらないようにする（#109）。
 *
 * **待つこと自体は正しい。** 問題は**待っている間に他の作業まで止まる**ことで、
 * **同時に open な PR は 1 本・worker は 1 人**なので、**1 件の人待ちがそのまま全停止**になる。
 * 実測で**約 2 時間、どちらのループも何も進めなかった**（#158）。
 */
describe("人の判断待ち", () => {
  /** master の手順書のうち、人を呼ぶ段。 */
  function humanBranch(): string {
    return procedureText("master").split("#### human — 人を呼ぶ")[1]?.split("\n#### ")[0] ?? "";
  }

  it("人を呼ぶときは、PR を保留にする", () => {
    // **保留にしないと、worker は次の PR を作れず、master は次を `ready` にできない**——
    // **紐づく Issue が `in-progress` のまま残る**ため。**両側で外して初めて経路が通る**
    const branch = humanBranch();

    expect(branch).toContain("--add-label");
    expect(branch).toContain("parked");
    expect(branch).toContain("awaiting-human");
  });

  it("人待ちでは、停止を数えない", () => {
    // **進めるようにしたのに `loop/STOP` に到達しては意味が無い。**
    // **数えない側へ倒した理由**を、手順書に残していること
    const branch = humanBranch();

    expect(branch).toMatch(/数えない|記録しない/);
    expect(branch, "倒した理由が書かれていない").toMatch(/loop\/STOP|止ま/);
  });

  it("誰が戻すのかが書いてある", () => {
    // **戻せるのが master だけなら、master が忘れると永久に止まる**（#109 の懸念）。
    // **人が外す**——判断した本人が、その場で戻せる形にする
    expect(humanBranch()).toMatch(/人が.*外す|人が.*戻/);
  });

  it("待っている相手を、PR に書くと定めている", () => {
    // **先行 PR を待つ場合と混ざると、何を待っているのか分からない `parked` が残る**
    expect(humanBranch()).toMatch(/何が決まれば/);
  });

  it("label が無い環境でも、保留にできる", () => {
    // **`./task loop:setup` は 1 度しか走らない。** 既に動いている作業場は
    // **マージしても label が増えない**（ステップ 1.1 は worktree を切り替えるだけ）——
    // **この PR が作ろうとしている経路そのものが動かない**。
    // **存在しない label を書いても GitHub は黙って落とす**、と `task` 自身が警告している
    expect(humanBranch()).toContain("gh label create");
  });

  it("保留に失敗したら、これまでどおり停止を数える", () => {
    // **付いていないのに保留したつもりになると、`ready` は上がらないまま
    // 「進めるようにした」と思い込む**——**いちばん危ない**。
    // **label を先に付け、成功を確認してから**（`changes-requested` と同じ順序）。
    //
    // **`|| true` で満たされる表明にしない。** 前の版は `/失敗|\|\|/` で、
    // **`gh label create … || true` の 1 行だけで通っていた**——**`if` を消して
    // 元の 2 行へ戻しても赤にならない**。**2 本立っているように見えて、
    // 押さえていたのは 1 本**だった（master の指摘）
    const branch = humanBranch();

    expect(branch, "付いたことを確かめていない").toMatch(/if gh pr edit .*--add-label/);
    expect(branch, "落ちたときの受け皿が無い").toContain("bin/loop-stall");
  });

  it("理由を投稿できなかったら、保留を残さない", () => {
    // **番号だけの保留が `loop:status` に出ると、見た人は「人待ちが 1 件ある」と読む**——
    // **中身が空だとは思わない**。**停止も積まれない**ので 3 周の経路にも乗らない。
    // **動いているように見えるぶん、こちらのほうが危ない**。
    // **戻して数える**（`--add-label` が落ちた場合と同じ形に畳める）
    const branch = humanBranch();

    expect(branch, "投稿の失敗を見ていない").toMatch(/if ! gh pr comment|gh pr comment .*\|\|/);
    expect(branch, "保留を戻していない").toContain("--remove-label");
  });

  it("人が判断を記録してから、label を外すと書いてある", () => {
    // **人が label だけ外しても、輪から出られない**——master が読むのは
    // **未解決スレッドの数と枠**だけで、**どちらも 1 回目と同じ値**なので、
    // **同じ入力に同じ答えが返り、また保留になる**。
    // **master が消費できる状態を残してから外す**（resolve するか、
    // `changes-requested` を付けるか）。**label を外すのは最後**である
    const section = read("loop/README.md").split("### 人の判断待ち（`awaiting-human`）")[1] ?? "";

    expect(section, "判断の記録が書かれていない").toMatch(/resolve/);
    expect(section, "直させる側の経路が書かれていない").toContain("changes-requested");

    // **打つ順序は、打つところで見る。** 節全体で見ると、**手前の散文に
    // `changes-requested` があるだけで順序が満たされる**——**先に外す形へ戻しても
    // 緑のまま**になる（実際にそうなった）
    const block =
      section
        .split("```bash")
        .slice(1)
        .map((chunk) => chunk.split("```")[0] ?? "")
        .find((chunk) => chunk.includes("--remove-label")) ?? "";

    expect(block.indexOf("changes-requested"), "打つ順序が書かれていない").toBeGreaterThanOrEqual(
      0,
    );
    expect(block.indexOf("--remove-label"), "label を外すのが先に書かれている").toBeGreaterThan(
      block.indexOf("changes-requested"),
    );
  });

  it("./task loop:status が、人待ちの PR を見せる", () => {
    // **止まっている理由が読めること**（#157 と同じ）。
    // **人待ちのまま忘れられる経路を作らない**ための、唯一の見える場所である
    const workspace = mkdtempSync(join(tmpdir(), "awaiting-human-"));
    try {
      expect(spawnSync("git", ["init", "--quiet", workspace]).status).toBe(0);
      const stub = join(workspace, "stub");
      mkdirSync(stub, { recursive: true });
      writeFileSync(
        join(stub, "gh"),
        [
          "#!/usr/bin/env bash",
          // **人待ちの一覧だけを返す。** 他の口は空でよい
          'if [[ $* == *"awaiting-human"* ]]; then',
          '  echo "  #158 材料が遅いときも縮退する"',
          "  exit 0",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      const shown = execFileSync(
        "bash",
        [
          "-c",
          `source ${JSON.stringify(join(REPO_ROOT, "task"))} >/dev/null 2>&1; ` +
            `cd ${JSON.stringify(workspace)}; ` +
            `PATH=${JSON.stringify(stub)}:$PATH cmd_loop_status`,
        ],
        { encoding: "utf8" },
      );

      expect(shown, "人待ちが見えない").toContain("158");
      expect(shown).toMatch(/人の判断待ち|awaiting-human/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  /** `show_awaiting_human` だけを、偽の `gh` で走らせる。 */
  function awaitingHumanWith(ghScript: string[]): string {
    const workspace = mkdtempSync(join(tmpdir(), "awaiting-human-"));
    try {
      const stub = join(workspace, "stub");
      mkdirSync(stub, { recursive: true });
      writeFileSync(join(stub, "gh"), ["#!/usr/bin/env bash", ...ghScript, ""].join("\n"), {
        mode: 0o755,
      });
      return execFileSync(
        "bash",
        [
          "-c",
          `source ${JSON.stringify(join(REPO_ROOT, "task"))} >/dev/null 2>&1; ` +
            `PATH=${JSON.stringify(stub)}:$PATH show_awaiting_human`,
        ],
        { encoding: "utf8" },
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  it("label 検索を使わず、取ってきた一覧から絞る", () => {
    // **索引は遅れる**（実測：付けた直後は 0 件、外した直後は 1 件）。
    // **人待ちにした直後に `loop:status` を見ると、その PR が出ない**——
    // **忘れられない側を担う唯一の経路**が、いちばん見たい瞬間に黙る。
    // **ステップ 6 が `parked` を数えるときに既にこの形**（全件から絞る）である
    const shown = awaitingHumanWith([
      // **`--label` で絞りに行ったら落とす。** 「使っていない」を出力で確かめる
      'if [[ $* == *"--label"* ]]; then echo "索引を使っている" >&2; exit 9; fi',
      'if [[ $* == *"pr list"* ]]; then',
      '  echo "  #158 材料が遅いときも縮退する"',
      "  exit 0",
      "fi",
      "exit 0",
    ]);

    expect(shown, "索引に頼っている").toContain("158");
  });

  it("読めなければ、黙って 0 件にしない", () => {
    // **取得に失敗しても「0 件」と同じ見た目**になると、**唯一の経路が黙って消える**。
    // `show_missing_lease` は既に「読めません」と言う形なので、揃える
    const shown = awaitingHumanWith(["exit 1"]);

    expect(shown, "読めないのに何も言わない").not.toBe("");
  });
});
