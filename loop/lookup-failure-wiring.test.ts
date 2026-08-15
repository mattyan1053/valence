import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LoopRole, procedureText } from "./procedure-doc";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** **両方の手順書を通しで見る**（#136 の「やること」）。 */
const PROCEDURES: readonly LoopRole[] = ["master", "worker"];

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/** 一覧を読む bash ブロックと、それが属する節。 */
type ReadBlock = { procedure: LoopRole; section: string; body: string };

/**
 * **一覧を読んでいるブロックを、全部並べる。**
 *
 * **名指ししない**（#166 で同じことを直した）——**名指しは、名指ししなかった経路を隠す**。
 */
function blocksIn(procedure: LoopRole): ReadBlock[] {
  const blocks: ReadBlock[] = [];
  let section = "";
  let body: string[] | undefined;
  for (const line of procedureText(procedure).split("\n")) {
    if (/^#{2,4} /.test(line)) {
      section = line.trim();
    }
    if (line.startsWith("```")) {
      const text = body?.join("\n");
      // **「一覧」を型で絞らない。** `gh issue list` / `gh pr list` だけを見ていたので、
      // **`gh api … /comments` が最初から候補に入っていなかった**（#136 のレビュー 2 周目）。
      // **#166 で「名指ししない」に直したが、今度は「型で絞った」**——
      // **絞り方が変わっただけで、絞ったものが隠れるのは同じ**である。
      // **GitHub から読むものは、すべて並べる。**
      if (text !== undefined && /gh (issue list|pr list|api )/.test(text)) {
        blocks.push({ procedure, section, body: text });
      }
      body = line.startsWith("```bash") ? [] : undefined;
      continue;
    }
    body?.push(line);
  }
  return blocks;
}

function readBlocks(): ReadBlock[] {
  return PROCEDURES.flatMap(blocksIn);
}

/**
 * 取得の失敗をどう受けているか。
 *
 * **「止める」だけが正解ではない。** 掃除のように**続けてよいもの**もあるが、
 * **黙って 0 件にするのだけは無し**——**どちらに倒したかを、並べて見る**。
 */
function disposition(block: ReadBlock): string {
  if (/bin\/loop-stall (issue|pr)-lookup-failed/.test(block.body)) {
    return "止める";
  }
  if (/if ! \w+="\$\(gh /.test(block.body)) {
    return "言って続ける";
  }
  return "受けていない";
}

/**
 * 一覧の取得に失敗したとき、「0 件」と読まない（#136）。
 *
 * **master 側は 4 箇所直したが、worker 側は 1 度も見ていない。**
 * **片方だけ直したまま**で、**同じ危険が残っている**。
 *
 * **症状が悪い。** worker が「`ready` が 0 件」と読むと**その周回は何もせず終わり**、
 * **GitHub の状態は正しいまま**である。**`bin/loop-stall` にも記録されない**ので、
 * **両方が正常に見えたまま、片方だけ止まる**。
 *
 * **`gh` を落とさないと 1 度も通らない。** **動いている周回だけを見ると、
 * 何もしなくても緑**になる——**偽の `gh` で exit 1 を返させて確かめる**。
 */
describe("一覧の取得に失敗した周回", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "lookup-failure-"));
    mkdirSync(join(workspace, "bin"), { recursive: true });
    // **`bin/loop-stall` は呼ばれたことだけを記録する**（本物は git の記録を触る）
    writeFileSync(
      join(workspace, "bin", "loop-stall"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >> ${JSON.stringify(join(workspace, "stalled"))}`,
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  /** `gh` を差し替えてブロックを走らせ、`bin/loop-stall` に何が渡ったかを返す。 */
  function runBlock(
    body: string,
    gh: string[],
  ): { status: number; stdout: string; stalled: string } {
    const stub = join(workspace, "stub");
    mkdirSync(stub, { recursive: true });
    writeFileSync(join(stub, "gh"), ["#!/usr/bin/env bash", ...gh, ""].join("\n"), { mode: 0o755 });
    const result = spawnSync("bash", ["-c", body], {
      cwd: workspace,
      encoding: "utf8",
      env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
    });
    const record = join(workspace, "stalled");
    return {
      status: result.status ?? -1,
      stdout: result.stdout,
      stalled: existsSync(record) ? readFileSync(record, "utf8") : "",
    };
  }

  /**
   * 走らせられる形にしたブロック。
   *
   * **穴があるものを外さない。** 外すと**そのブロックだけ実行の試験を通らない**——
   * **`<番号>` があるという理由で、いちばん確かめたい経路が抜ける**。
   * **穴は埋めて走らせる**（偽の `gh` は引数を見ない）。
   */
  function runnable(): ReadBlock[] {
    return readBlocks().map((block) => ({ ...block, body: block.body.replace(/<[^>]+>/g, "1") }));
  }

  it("一覧を読む節を、全部並べて突き合わせる", () => {
    // **絞ってから見ない。** **読んでいるのに受けていない節**が 1 つでもあれば、
    // そこから「0 件」に化ける
    expect(
      readBlocks().map((block) => [`${block.procedure} ${block.section}`, disposition(block)]),
    ).toEqual([
      ["master ## 2. open PR を見て、見る順番を決める", "止める"],
      // **保留の一覧も止める**（#70）。**0 件と読むと、ループの外の著者が対応した
      // 保留を誰も外さない**——**push しても誰も見に来ない**状態がそのまま残る
      ["master ## 2. open PR を見て、見る順番を決める", "止める"],
      // **掃除は続けてよい**（残骸が残るだけで、判断は変わらない）。**ただし言う**
      ["master ### exit 0 — マージする", "言って続ける"],
      ["master ## 6. 着手順を決める（`ready` を 2 件までに保つ）", "止める"],
      ["master ## 6. 着手順を決める（`ready` を 2 件までに保つ）", "止める"],
      ["worker ### 2.0 届いた指示を先に確認する", "止める"],
      // **コメントも「読むもの」である。** ここで読むのは **`blocked` の指示と
      // master からの割り込み**で、**0 件と読むと、止められているのに手を止めない**
      ["worker ### 2.0 届いた指示を先に確認する", "止める"],
      ["worker ### 2.1 master へ知らせる", "止める"],
      ["worker ### 2.2 公開に失敗した周回を再開する", "止める"],
      ["worker ### 2.2 公開に失敗した周回を再開する", "止める"],
      ["worker ## 4. `ready` から 1 件を取って実装する", "止める"],
    ]);
  });

  it("gh が落ちたら、0 件と別の道へ進む", () => {
    // **これが本命である。** **落ちる理由が狙ったものと一致すること**まで見る
    const blocks = runnable();
    // **1 つも外さない。** 外したブロックは**列挙にだけ載って、実行では確かめられない**——
    // **`<番号>` があるという理由で、いちばん確かめたい経路が抜ける**
    expect(blocks.length, "実行で確かめていないブロックがある").toBe(readBlocks().length);

    for (const block of blocks) {
      rmSync(join(workspace, "stalled"), { force: true });

      const result = runBlock(block.body, ['echo "API 障害" >&2', "exit 1"]);

      if (disposition(block) === "止める") {
        expect(result.stalled, `${block.section}: 取得の失敗を受けていない`).toMatch(
          /(issue|pr)-lookup-failed/,
        );
        // **記録したら、そこで終える。** **続けると、失敗した周回が先へ進む**——
        // **取れなかった値を、取れたかのように使う**ことになる
        expect(result.stdout, `${block.section}: 失敗したのに先へ進んでいる`).toBe("");
      } else {
        // **続ける側は、言うことだけを見る**（記録は積まない）
        expect(result.stalled, `${block.section}: 続ける側で止めている`).toBe("");
      }
    }
  });

  it("gh が成功したら、読めるところへ出す", () => {
    // **失敗を直して、成功を壊さない**（master の指摘）。**受けただけで使わないと、
    // 成功した周回で何も出ない**——**0 件かどうかも、どれを選ぶかも、出力を見て決める**。
    //
    // **失敗は障害のときだけだが、成功は毎周回**である——**同じ穴の、もっと広い側**。
    for (const block of runnable()) {
      const result = runBlock(block.body, ["printf '%s\\n' 'MARK Closes #42'", "exit 0"]);

      // **「出す」には「使った結果を出す」も含む**（掃除のブロックは番号を消費して
      // 件数を出す）。**見たいのは、取ったものが表に出ること**である
      expect(result.stdout.trim(), `${block.section}: 取ったものが表に出ていない`).not.toBe("");
    }
  });

  it("0 件のときは、止めない", () => {
    // **「無かった」と「読めなかった」を同じ値に丸めない**（#125 と同じ家族）。
    // **逆向きに丸めても壊れる**——**正常に 0 件の周回で毎回止まる**
    for (const block of runnable()) {
      rmSync(join(workspace, "stalled"), { force: true });

      const result = runBlock(block.body, ['printf ""', "exit 0"]);

      expect(result.stalled, `${block.section}: 0 件で止めている`).toBe("");
    }
  });
});
