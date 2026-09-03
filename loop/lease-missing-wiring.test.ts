import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
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
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/**
 * 入口を飛ばした記録が、**人の目に触れる場所へ出るか**。
 *
 * **記録するだけでは終わらない。** 誰も読まない場所に積むと、
 * **「あとから分かる」は「探し方を知っている人にだけ分かる」**になる——
 * この Issue（#143）が問題にしたのは、まさに**気づけないこと**だった。
 */
describe("入口を飛ばした記録", () => {
  it("出口が飛ばしを見つけると書いてある", () => {
    // **判断はスクリプトが持つ。** ここでは「見る場所がある」ことだけを固定する
    expect(read("bin/loop-handoff")).toContain("loop-lease");
  });

  it("./task loop:status が、溜まった記録を見せる", () => {
    // **見えなければ、記録は無いのと同じ。** 溜まっていることが分かるのは、
    // **周回のたびに読む場所**に出たときだけである。
    //
    // **関数を直接呼んで確かめない。** それだと**呼び出しを外しても緑のまま**になる
    // （実際に変異で通ってしまった）——**見たいのは「配線されていること」**である
    const workspace = mkdtempSync(join(tmpdir(), "lease-missing-"));
    try {
      expect(spawnSync("git", ["init", "--quiet", workspace]).status).toBe(0);
      appendFileSync(
        join(workspace, ".git", "valence-loop-lease-missing"),
        "2026-08-11T20:00:00Z\tworker\t/somewhere\n",
      );
      // **`gh` は呼ばせない。** 見たいのは記録の出方で、GitHub の中身ではない
      const stub = join(workspace, "stub");
      mkdirSync(stub, { recursive: true });
      writeFileSync(join(stub, "gh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

      const shown = execFileSync(
        "bash",
        [
          "-c",
          // **`task` は読み込むと自分でリポジトリ根へ移動する。** 先に読み込んでから、
          // 見たい作業場へ入る（順番を逆にすると、実リポジトリの記録を読む）
          `source ${JSON.stringify(join(REPO_ROOT, "task"))} >/dev/null 2>&1; ` +
            `cd ${JSON.stringify(workspace)}; ` +
            `PATH=${JSON.stringify(stub)}:$PATH cmd_loop_status`,
        ],
        { encoding: "utf8" },
      );

      expect(shown).toContain("worker");
      expect(shown).toMatch(/lease/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("周回が飛ばしたとは書かない（診断で叩いたものが混ざる）", () => {
    // **数えているのは「lease 無しでスクリプトが動いた」**であって、
    // **「周回が入口を飛ばした」ではない**（#192）。**診断のために人が
    // `bin/loop-gate` を手で叩くと、そのまま記録される**——**実測で 18 件中 7 件**。
    //
    // **コマンド名を残しても見分けは付かない。** **飛ばした周回も、診断の人も、
    // 同じ `bin/loop-gate` を叩く**——**違うのは呼び手の役**で、
    // **それを知る唯一の手段が lease**である。**その lease が無いときの話**なので、
    // **見分けは原理的に取れない。だから、名前を数えているものへ合わせる。**
    const workspace = mkdtempSync(join(tmpdir(), "lease-missing-"));
    try {
      expect(spawnSync("git", ["init", "--quiet", workspace]).status).toBe(0);
      appendFileSync(
        join(workspace, ".git", "valence-loop-lease-missing"),
        "2026-08-13T01:27:28Z\t別の周回が保持中: master\t/somewhere\n",
      );

      const shown = execFileSync(
        "bash",
        [
          "-c",
          `source ${JSON.stringify(join(REPO_ROOT, "task"))} >/dev/null 2>&1; ` +
            `cd ${JSON.stringify(workspace)}; show_missing_lease`,
        ],
        { encoding: "utf8" },
      );

      expect(shown, "周回が飛ばしたと言い切っている").not.toContain("入口を飛ばした周回");
      expect(shown, "診断で叩いたものが混ざることが書かれていない").toContain("診断");
      expect(shown, "件数が消えている").toContain("1 件");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("./task help から、記録を見せるコマンドの説明が読める", () => {
    // **この PR の理由が、この PR 自身に当たった。** 記録を `loop:status` へ出すと決めた
    // のに、**同じ変更で「`loop:status` が何をするコマンドなのか」が一覧から読めなく
    // なっていた**——`cmd_help` は**定義の直前のコメント**を説明として拾うので、
    // **間に関数を挟むと説明が消える**。
    //
    // **「動くこと」を見ても分からない**（`loop:status` 自体は正しく動く）。
    // **出力を見なければ捕まらない**——#155 で踏んだ「配線されていること」と同じ家族である
    // **色の指定を落としてから読む。** 残したまま `\S` で見ると、
    // **色の指定そのものが「説明がある」を満たしてしまう**（空振りする）。
    // 制御文字を正規表現のリテラルに書けないので、組み立てて渡す
    const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
    // **実物を呼ばない** (#587)。**砂場へ複製してから走らせる**——**`help` は
    // 自分の中身を読んで出すだけ**なので、**複製でも同じものが出る。**
    const box = mkdtempSync(join(tmpdir(), "task-help-"));
    copyFileSync(join(REPO_ROOT, "task"), join(box, "task"));
    chmodSync(join(box, "task"), 0o755);
    const help = execFileSync("./task", ["help"], { cwd: box, encoding: "utf8" }).replaceAll(
      ansi,
      "",
    );
    rmSync(box, { recursive: true, force: true });

    expect(help).toMatch(/^\s+loop:status\s+\S/m);
  });

  it("記録が読めなければ、黙って 0 件にしない", () => {
    // **「1 度も飛ばしていない」と「読めない」を同じ静けさにしない。**
    //
    // **書けなかった場合は、ここでは分からない**——**分かるのは書こうとした瞬間だけ**
    // なので、そこで言う（`bin/loop-handoff`）。**2 箇所で同じことを見張らない。**
    // ここで分かるのは**「ファイルはあるのに読めない」**までで、それは言う
    const workspace = mkdtempSync(join(tmpdir(), "lease-missing-"));
    try {
      expect(spawnSync("git", ["init", "--quiet", workspace]).status).toBe(0);
      const record = join(workspace, ".git", "valence-loop-lease-missing");
      appendFileSync(record, "2026-08-11T20:00:00Z\tworker\t/somewhere\n");
      chmodSync(record, 0o000);

      const shown = execFileSync(
        "bash",
        [
          "-c",
          `source ${JSON.stringify(join(REPO_ROOT, "task"))} >/dev/null 2>&1; ` +
            `cd ${JSON.stringify(workspace)}; show_missing_lease`,
        ],
        { encoding: "utf8" },
      );

      expect(shown, "読めないのに何も言わない").not.toBe("");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("記録が無ければ、何も言わない", () => {
    // **静かなときに騒がない。** 毎周回読む場所なので、
    // **無い状態が「異常なし」だと一目で分かる**必要がある
    const workspace = mkdtempSync(join(tmpdir(), "lease-missing-"));
    try {
      expect(spawnSync("git", ["init", "--quiet", workspace]).status).toBe(0);
      const shown = execFileSync(
        "bash",
        [
          "-c",
          // **`task` は読み込むと自分でリポジトリ根へ移動する。** 先に読み込んでから、
          // 見たい作業場へ入る（順番を逆にすると、実リポジトリの記録を読む）
          `source ${JSON.stringify(join(REPO_ROOT, "task"))} >/dev/null 2>&1; ` +
            `cd ${JSON.stringify(workspace)}; show_missing_lease`,
        ],
        { encoding: "utf8" },
      );

      expect(shown).toBe("");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
