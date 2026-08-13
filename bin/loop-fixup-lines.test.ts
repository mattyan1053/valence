import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-fixup-lines", import.meta.url));

/**
 * レビュー用の bot。**値はここに書き写さない**——`bin/loop-review-commits` が正で、
 * このスクリプトもそこから取る（書き写すと、片方だけ直したときに食い違う）。
 */
const BOT = execFileSync(fileURLToPath(new URL("./loop-review-commits", import.meta.url)), [
  "--bot",
])
  .toString()
  .trim();
/** GraphQL は `[bot]` を付けずに返す（REST は付ける）。 */
const BOT_GRAPHQL = BOT.replace(/\[bot\]$/, "");

const PR = "124";
const REVIEWED = "a".repeat(40);
const HEAD = "b".repeat(40);
/** 前の周期のレビューが付いた commit（**測る窓の外**）。 */
const OLDER = "c".repeat(40);
/** 窓の中の commit（レビュー後に worker が積んだもの）。 */
const INNER = "d".repeat(40);

/** gh の `--jq` の `@base64` と同じ符号化。**復号はどこでもしない。** */
function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

type Run = { status: number; stdout: string; stderr: string };

/** bash だけを置いた PATH。gh がここに無いので、到達すれば別の失敗になる。 */
let binDir: string;

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "loop-fixup-bin-"));
  symlinkSync("/usr/bin/bash", join(binDir, "bash"));
});

afterAll(() => {
  rmSync(binDir, { recursive: true, force: true });
});

/** 入力検査だけを通す（gh を呼ばせない）。 */
function run(args: string[]): Run {
  const result = spawnSync(SCRIPT, args, {
    encoding: "utf8",
    env: { ...process.env, PATH: binDir },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

type Fake = {
  /** compare が返す行（`T\t<型>`、`C\t<窓の中の commit>`、`F\t…`）。 */
  files: string[];
  /** レビュースレッドの取得が返す行（`T\t<型>` と `P\t…`）。 */
  threads?: string[];
  compareExit?: number;
  threadsExit?: number;
  /** 最後にレビューされた commit。短縮形も来る。 */
  reviewed?: string;
};

/**
 * gh を差し替えて、スクリプトが受け取る行をそのまま渡す。
 * 差し替えが返すのは **ファイルごとの生の行数** で、分類も合計もスクリプト側で行う。
 * ここを gh の --jq に寄せると、テストは「あらかじめ数えた答え」を渡すだけになり、
 * **数え方そのものを 1 つも検証できない**。
 *
 * `files` が配列かどうかも `T\t<型>` の 1 行として受け取る。コンテナに jq が無く、
 * 差し替えた gh は `--jq` を実行できないので、**生の JSON を渡すテストは書けない**。
 * 型を出力の一部にしてあるので、**判定そのものはここで検証できる**。
 *
 * **呼び出しは 2 つある**（差分と、レビュースレッドの一覧）。引数で分岐させるので、
 * 呼ぶ場所が変われば、ここも合わなくなる。
 */
function runWithLines(fake: Fake): Run {
  const dir = mkdtempSync(join(tmpdir(), "loop-fixup-fake-"));
  symlinkSync("/usr/bin/bash", join(dir, "bash"));
  // **符号化を戻すのに要る**（判定を `--jq` へ寄せられないため。#208 のレビュー）
  symlinkSync("/usr/bin/base64", join(dir, "base64"));
  const emit = (lines: string[]): string[] =>
    // %b で渡す。%s だと JSON.stringify が付けた \t が **タブに戻らず**、
    // 列の分かれていない行を渡してしまう
    lines.map((line) => `printf '%b\\n' ${JSON.stringify(line)}`);
  writeFileSync(
    join(dir, "gh"),
    [
      "#!/usr/bin/env bash",
      'args="$*"',
      "require() {",
      "  local frag",
      '  for frag in "$@"; do',
      '    if [[ $args != *"$frag"* ]]; then',
      '      echo "スタブ: 想定外の gh 呼び出し ($frag が無い): $args" >&2',
      "      exit 1",
      "    fi",
      "  done",
      "}",
      'case "$args" in',
      // **レビュースレッドの取得。** 何を「要求された変更」と見なすかを決める問い合わせで、
      // **パスは符号化したまま**受け取る（復号すると、区切りを含む名前で数が狂う）
      '  "api graphql"*)',
      '    require "--jq" "reviewThreads" ".path" "@base64" "pageInfo" "originalCommit" "author"',
      ...emit(fake.threads ?? ["T\\tarray"]).map((line) => `    ${line}`),
      `    exit ${fake.threadsExit ?? 0}`,
      "    ;;",
      "  *)",
      // **--jq の式まで見る。** ファイル名を符号化しているのは gh 側の --jq なので、
      // ここを見ないと **@base64 を外しても緑のまま**になる
      // **判定の式まで見る。** テストかどうかを決めているのは gh 側の --jq なので、
      // ここを見ないと **判定を外しても緑のまま**になる
      // **新しいファイルと、それを呼んでいるファイル**も同じ 1 回で受け取る（#204）。
      // **`.status` と `.patch` を尋ねていること**まで見る——**外しても緑のまま**にしない
      '    require "--jq" ".filename" \'endswith(".test.ts")\' "@base64" ".additions" ".deletions" ".commits" ".status" ".patch"',
      ...emit(fake.files).map((line) => `    ${line}`),
      `    exit ${fake.compareExit ?? 0}`,
      "    ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const result = spawnSync(SCRIPT, [PR, fake.reviewed ?? REVIEWED, HEAD], {
    encoding: "utf8",
    env: { ...process.env, PATH: dir },
  });
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/**
 * `F\t<テストか>\t<符号化したパス>\t<追加>\t<削除>` の 1 行を作る。
 *
 * **生のファイル名は載らない。** テストかどうかの判定は gh の `--jq` で終わっていて、
 * 外へ出るのは `true` / `false` と **符号化したパス**と数値だけである（生の名前を出すと、
 * 区切りや末尾の空白で数を狂わせられる。実際に両方踏んだ）。
 * **その判定式はスタブが検査している。**
 */
function row(path: string, isTest: boolean, additions: number, deletions: number): string {
  return `F\t${isTest}\t${b64(path)}\t${additions}\t${deletions}`;
}

/** `N\t<符号化したパス>` の 1 行（**この窓で作られたファイル**）。 */
function newFile(path: string): string {
  return `N\t${b64(path)}`;
}

/**
 * `D\t<符号化したパス>\t<符号化した差分>` の 1 行。
 *
 * **生の差分をここへ渡す。** **「呼ばれている」の判定は本体（bash）が持つ**ので、
 * **加工済みの答えを渡すと、判定を 1 度も通らない**（#208 のレビュー。
 * **差し替えた gh は `--jq` を実行しない**ので、式の中に意味を置けない）。
 */
function patchOf(path: string, patch: string): string {
  return `D\t${b64(path)}\t${b64(patch)}`;
}

/**
 * レビュースレッドの 1 行。
 *
 * **どの commit に対して付いた指摘か**と**誰が付けたか**を持つ。前者が無いと
 * **前の周期のスレッドが残っているだけでそのファイルが永久に除外され**、後者が無いと
 * **PR の作成者が自分でコメントを付けて除外できる**（どちらも実際に指摘された）。
 */
function thread(path: string, onCommit: string = REVIEWED, author: string = BOT_GRAPHQL): string {
  return `P\t${onCommit}\t${author}\t${b64(path)}`;
}

/** files が配列だったとき（正常）の出力を作る。 */
function runWithFiles(
  rows: string[],
  threads: string[] = [],
  commits: string[] = [],
  mentions: string[] = [],
): Run {
  return runWithLines({
    files: ["T\tarray", ...commits.map((sha) => `C\t${sha}`), ...rows, ...mentions],
    threads: ["T\tarray", ...threads],
  });
}

describe("要求に応えて作った新しいファイル", () => {
  // **`AGENTS.md` §5 は「重複は 3 回目に抽象化する」と言い、第 3 層は抽象化を
  // 「広がった」と数える**——**規約どおり直すと機械が止める**（#204。#202 で踏んだ）。
  //
  // **新しいファイルにはスレッドが付きようがない**ので、**要求ぶんとして外れない。**
  // **要求されたファイルが、その名前を書いているか**で見る——**呼び出しは機械的に見える。**

  it("要求されたファイルの追加行が呼んでいれば、数えない", () => {
    // **入力に 2 つ要る**（#204 の完了条件）——**新しいファイルが 1 つだけだと、
    // 「全部の新しいファイルを外す」でも緑になる。**
    const result = runWithFiles(
      [
        row(".claude/commands/loop-worker.md", false, 12, 4),
        row("bin/loop-keep-branch", false, 75, 0),
        row("bin/loop-unrelated", false, 30, 0),
      ],
      [thread(".claude/commands/loop-worker.md")],
      [],
      [
        newFile("bin/loop-keep-branch"),
        newFile("bin/loop-unrelated"),
        patchOf(
          ".claude/commands/loop-worker.md",
          "@@ -1 +1 @@\n-git push origin\n+bin/loop-keep-branch <ブランチ>\n",
        ),
      ],
    );

    expect(result.status, result.stderr).toBe(0);
    // **要求されたファイル 16 行と、そこから呼ばれる 75 行が外れる。**
    // **無関係な 30 行は、これまでどおり数える**（外しすぎない）
    expect(result.stdout.trim()).toBe("30\t0\t91");
  });

  it("短い名前が偶然含まれても、数える", () => {
    // **部分文字列では足りない**（#208 のレビュー）——**`a` のような名前は、
    // 要求ファイルの差分に文字 `a` が 1 度出るだけで外れる**。
    // **名前を短くするだけで第 3 層を抜けられる**なら、網ではない。
    const result = runWithFiles(
      [row(".claude/commands/loop-worker.md", false, 2, 0), row("a", false, 500, 0)],
      [thread(".claude/commands/loop-worker.md")],
      [],
      [newFile("a"), patchOf(".claude/commands/loop-worker.md", "@@ -1 +1 @@\n+bash の話をする\n")],
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim(), "短い名前で抜けられている").toBe("500\t0\t2");
  });

  it("メタ文字を含む名前でも、似た綴りには当たらない", () => {
    // **`x.ts` が `xats` に当たる**形にしない（正規表現に生のまま渡さない）
    const result = runWithFiles(
      [row(".claude/commands/loop-worker.md", false, 2, 0), row("x.ts", false, 40, 0)],
      [thread(".claude/commands/loop-worker.md")],
      [],
      [newFile("x.ts"), patchOf(".claude/commands/loop-worker.md", "@@ -1 +1 @@\n+xats を足す\n")],
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim(), "メタ文字が当たっている").toBe("40\t0\t2");
  });

  it("削除行にしか無ければ、数える", () => {
    // **消した行の言及は、呼んでいる証拠にならない**
    const result = runWithFiles(
      [
        row(".claude/commands/loop-worker.md", false, 0, 2),
        row("bin/loop-keep-branch", false, 75, 0),
      ],
      [thread(".claude/commands/loop-worker.md")],
      [],
      [
        newFile("bin/loop-keep-branch"),
        patchOf(
          ".claude/commands/loop-worker.md",
          "@@ -1 +1 @@\n-bin/loop-keep-branch <ブランチ>\n",
        ),
      ],
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim(), "削除行の言及で外れている").toBe("75\t0\t2");
  });

  it("要求されていないファイルから呼ばれていても、数える", () => {
    // **網を外して緑にしない。** **要求と無関係なファイルが名前を書いただけで
    // 外れるなら、第 3 層は自分で無効にできる。**
    const result = runWithFiles(
      [row("bin/loop-other", false, 5, 0), row("bin/loop-keep-branch", false, 75, 0)],
      [],
      [],
      [
        newFile("bin/loop-keep-branch"),
        patchOf("bin/loop-other", "@@ -1 +1 @@\n+bin/loop-keep-branch を呼ぶ\n"),
      ],
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("80\t0\t0");
  });

  it("差分が来ていなければ、これまでどおり数える", () => {
    // **外れるのは「この窓で作られたファイル」だけ**である——**既にあったものは、
    // 要求されたファイルが名前を書いただけで丸ごと外れてはいけない。**
    //
    // **「作られたファイルだけ」を選んでいるのは gh 側の `--jq`**（`.status`）なので、
    // **ここでは「言及元が来ない」ことしか作れない**——**式そのものは
    // 「判定式が想定どおりであること」が留めている**（テストかどうかの判定と同じ扱い）。
    const result = runWithFiles(
      [row(".claude/commands/loop-worker.md", false, 12, 4), row("bin/loop-stall", false, 40, 0)],
      [thread(".claude/commands/loop-worker.md")],
      [],
      [],
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("40\t0\t16");
  });
});

describe("bin/loop-fixup-lines の数え方", () => {
  it("本体の変更は追加も削除も数える", () => {
    const result = runWithFiles([row("bin/loop-merge", false, 34, 7)]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("41\t0\t0");
  });

  it("テストの追加行は数えない", () => {
    // 危険なのは「レビューを受けていない本体の変更」であって、守りが増えることではない
    const result = runWithFiles([
      row("bin/loop-merge", false, 34, 7),
      row("bin/loop-merge.test.ts", true, 43, 0),
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("41\t43\t0");
  });

  it("テストの削除行は数える", () => {
    // 「テストファイルだから安全」ではない。**守りを減らす変更は本体と同じ**に扱う。
    // ここを追加と一緒に除外すると、レビュー後に検証を消しても素通りする
    const result = runWithFiles([row("bin/loop-merge.test.ts", true, 0, 30)]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("30\t0\t0");
  });

  it("同じファイルで追加と削除が混ざっていても、削除だけを数える", () => {
    const result = runWithFiles([row("bin/loop-merge.test.ts", true, 12, 5)]);

    expect(result.stdout.trim()).toBe("5\t12\t0");
  });

  it("本体とテストが混ざっていても、それぞれの規則で数える", () => {
    // どのファイルがテストかを決めているのは **gh 側の --jq**（式はスタブが検査する）。
    // ここで見るのは、その判定を受けてからの数え方
    const result = runWithFiles([
      row("a", false, 10, 0),
      row("b", false, 5, 0),
      row("c.test.ts", true, 7, 0),
    ]);

    expect(result.stdout.trim()).toBe("15\t7\t0");
  });

  it("テストか否か以外の値が来たら失敗する", () => {
    // **ファイル名は PR 側で決められる**（git のパスにはタブも改行も入る）。
    // 名前をこの欄へ出していた頃は、区切りを含む 1 件が 3 行に割れて数が狂い
    // （実測 `3\t500`）、符号化して復号する形でも **末尾の改行がコマンド置換で落ちて**
    // `payload.test.ts\n` がテスト扱いになった（実測 `0\t500`）。
    // いまも true/false しか通さず、パスは**符号化したまま**扱う
    expect(
      runWithFiles([row("a", false, 1, 2), `F\tpayload.test.ts\t${b64("x")}\t500\t0`]).status,
    ).toBe(1);
    expect(runWithFiles([`F\tTrue\t${b64("x")}\t1\t2`]).status).toBe(1);
  });

  it("変更ファイルが 0 件なら 0 を返す", () => {
    const result = runWithFiles([]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0\t0\t0");
  });

  it("行数として読めない行があれば失敗する", () => {
    // 0 として数えると、**取得の壊れが「手直しが小さい」に化けて素通りする**
    const result = runWithFiles([row("a", false, 34, 7), `F\tmaybe\t${b64("b")}\t1\t2`]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("読めません");
  });

  it("列が足りない行があれば失敗する", () => {
    const result = runWithFiles(["bin/loop-merge\t34"]);

    expect(result.status).toBe(1);
  });

  it("符号化されていないパスが来たら失敗する", () => {
    // **符号化を外すと、区切りを含む名前で列がずれる。** 形で弾く
    const result = runWithFiles([`F\tfalse\tbin/loop merge\t1\t2`]);

    expect(result.status).toBe(1);
  });

  it("gh が失敗したら失敗として返す（0 行と扱わない）", () => {
    const result = runWithLines({ files: ["T\tarray"], compareExit: 1 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("取得できません");
  });
});

describe("bin/loop-fixup-lines はレビューが要求した変更を数えない", () => {
  // **よく見たから止まる、が起きていた。** master が指摘し、その指摘どおりに直すほど
  // 行数が増え、第 3 層が「レビューされていない変更」として人を呼ぶ。
  // 実測で 4 件中 4 件（#36 / #41 / #96 / #124）が人の結論と食い違っていた。
  //
  // **#124 は同じ PR の中で数字が変わった。** 2 回目のレビュー時点を基準にすると 89 行、
  // 3 回目のレビューが届いた瞬間に 37 行。**変わったのは PR ではなくレビューの回数**だった。

  it("レビュースレッドのあるファイルの本体変更は数えない", () => {
    // 指摘の付いたファイルへの変更は、**指摘した側が見た範囲**である
    const result = runWithFiles([row("bin/loop-claim", false, 60, 29)], [thread("bin/loop-claim")]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0\t0\t89");
  });

  it("スレッドの無いファイルの変更は、これまでどおり数える", () => {
    // **これが無いと、ただ緩めただけになる。** worker が自分の判断で足したものは
    // 誰も見ていない
    const result = runWithFiles(
      [row("bin/loop-claim", false, 60, 29), row("bin/loop-gate", false, 30, 0)],
      [thread("bin/loop-claim")],
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("30\t0\t89");
  });

  it("スレッドが 1 件も無ければ、何も除外しない", () => {
    // 指摘が無かった PR で、レビュー後に足した変更は**誰も見ていない**
    const result = runWithFiles([row("bin/loop-claim", false, 60, 29)], []);

    expect(result.stdout.trim()).toBe("89\t0\t0");
  });

  it("スレッドのあるファイルでも、テストの削除は数える", () => {
    // **守りを減らす変更は本体と同じ**（#126 の「扱いを変えない」）。
    // 指摘に応じてでも、検証が消えたことは見えなくならない
    const result = runWithFiles(
      [row("bin/loop-claim.test.ts", true, 12, 30)],
      [thread("bin/loop-claim.test.ts")],
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("30\t12\t0");
  });

  it("除外した理由ごとに、別の欄で返す", () => {
    // **1 つに足し込むと、どちらの規則で消えたのか分からなくなる。**
    // ゲートの出力がそのまま人の判断材料になる
    const result = runWithFiles(
      [
        row("bin/loop-claim", false, 89, 0),
        row("bin/loop-claim.test.ts", true, 100, 0),
        row("bin/loop-gate", false, 7, 0),
      ],
      [thread("bin/loop-claim")],
    );

    expect(result.stdout.trim()).toBe("7\t100\t89");
  });

  it("パスは復号せず、符号化したまま突き合わせる", () => {
    // **git のパスにはタブも改行も入る。** 復号して比べると、名前 1 つで
    // 行を増やせる（実測: 区切りを含む名前 1 件が 3 行に割れた）
    const nasty = "bin/a\tb\nc";
    const result = runWithFiles([row(nasty, false, 40, 0)], [thread(nasty)]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0\t0\t40");
  });

  it("スレッドを取得できなければ失敗する（0 件と扱わない）", () => {
    // **0 件として続けると、この修正が静かに無効化される。** 症状は
    // 「正しい PR がまた止まる」だけなので、**壊れたことに誰も気づけない**
    const result = runWithLines({
      files: ["T\tarray", row("bin/loop-claim", false, 89, 0)],
      threadsExit: 1,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("レビュースレッド");
  });

  it("スレッドの一覧が配列として返っていなければ失敗する", () => {
    // 取得の失敗と「スレッド 0 件」はどちらも本文が空になる。**型で見分ける**
    expect(runWithLines({ files: ["T\tarray"], threads: ["T\tnull"] }).status).toBe(1);
    expect(runWithLines({ files: ["T\tarray"], threads: [] }).status).toBe(1);
  });

  it("スレッドの行が読めなければ失敗する", () => {
    const result = runWithLines({
      files: ["T\tarray"],
      threads: ["T\tarray", `P\t${REVIEWED}\t${BOT_GRAPHQL}\tbin/loop-claim`],
    });

    expect(result.status).toBe(1);
  });
});

describe("bin/loop-fixup-lines は前の周期のスレッドを除外に使わない", () => {
  // **「そのファイルに指摘が付いたことがある」では緩すぎる。** 第 1 回で指摘され、
  // 解決したファイルを、**第 2 回のレビュー後に大幅に書き換える**と、その変更は
  // 誰も見ていないのに 0 行として扱われ、上限到達後のゲートを素通りする。
  //
  // **除外してよいのは、いま測っている窓の中で要求されたものだけ**である。
  // 窓は「最後にレビューされた commit から head まで」で、そこへ付いた指摘は
  // **その commit（またはその後に積んだ commit）に対して**書かれている。

  it("窓の外の commit へ付いたスレッドは、除外に使わない", () => {
    const result = runWithFiles(
      [row("bin/loop-claim", false, 60, 29)],
      [thread("bin/loop-claim", OLDER)],
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("89\t0\t0");
  });

  it("同じファイルに新旧のスレッドがあれば、新しいほうで除外する", () => {
    // **古いのが残っていても、今回も指摘されているなら要求である**
    const result = runWithFiles(
      [row("bin/loop-claim", false, 60, 29)],
      [thread("bin/loop-claim", OLDER), thread("bin/loop-claim", REVIEWED)],
    );

    expect(result.stdout.trim()).toBe("0\t0\t89");
  });

  it("窓の中で積んだ commit へ付いたスレッドも除外する", () => {
    // 直している途中の commit へ指摘が付くことがある。**それも要求である**
    const result = runWithFiles(
      [row("bin/loop-claim", false, 40, 0)],
      [thread("bin/loop-claim", INNER)],
      [INNER],
    );

    expect(result.stdout.trim()).toBe("0\t0\t40");
  });

  it("レビューされた commit が短縮形でも突き合わせられる", () => {
    // **会話コメント由来の SHA は短縮形**（bin/loop-review-commits が返す）。
    // 完全一致で見ると、そこだけ除外が効かなくなる
    const result = runWithLines({
      files: ["T\tarray", row("bin/loop-claim", false, 40, 0)],
      threads: ["T\tarray", thread("bin/loop-claim", REVIEWED)],
      reviewed: REVIEWED.slice(0, 7),
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0\t0\t40");
  });

  it("どの commit へ付いたか分からないスレッドは、除外に使わない", () => {
    // 消えた commit を指すスレッドは originalCommit が空で返る。
    // **分からないものを「要求された」に倒さない**
    const result = runWithFiles(
      [row("bin/loop-claim", false, 40, 0)],
      [thread("bin/loop-claim", "-")],
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("40\t0\t0");
  });

  it("窓の commit 一覧が読めなければ失敗する", () => {
    // **一覧が壊れているのに続けると、除外の範囲が黙って狭まる**
    const result = runWithLines({
      files: ["T\tarray", "C\tnot-a-sha", row("bin/loop-claim", false, 40, 0)],
    });

    expect(result.status).toBe(1);
  });
});

describe("bin/loop-fixup-lines は自分で付けた指摘を要求と見なさない", () => {
  // **「レビューが要求した変更は数えない」が「自分で要求すれば数えない」になっていた。**
  // PR の作成者が自分の変更ファイルへインラインコメントを付けて resolve すれば、
  // そのファイルは丸ごと除外される。**未解決スレッド 0 件の条件と併せると、
  // 誰も見ていない大きな変更がゲートを通る。**
  //
  // bin/loop-review-commits と bin/loop-gate は「誰のレビューか」を固定しているのに、
  // **ここだけ全投稿者を信用していた**。

  it("PR の作成者が付けたインラインコメントでは除外されない", () => {
    const result = runWithFiles(
      [row("bin/loop-claim", false, 89, 0)],
      [thread("bin/loop-claim", REVIEWED, "mattyan1053")],
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("89\t0\t0");
  });

  it("固定したレビュー用の bot のスレッドだけを除外に使う", () => {
    // **値は bin/loop-review-commits から取る**（書き写すと片方だけ直して食い違う）
    const result = runWithFiles(
      [row("bin/loop-claim", false, 89, 0)],
      [thread("bin/loop-claim", REVIEWED, BOT_GRAPHQL)],
    );

    expect(result.stdout.trim()).toBe("0\t0\t89");
  });

  it("REST の形（末尾に [bot] が付く）でも同じ bot として扱う", () => {
    // **GraphQL は `[bot]` を付けずに返すが、付く形で来ても取り違えない。**
    // 付いた形は GitHub のログイン名として作れないので、なりすましにはならない
    const result = runWithFiles(
      [row("bin/loop-claim", false, 89, 0)],
      [thread("bin/loop-claim", REVIEWED, BOT)],
    );

    expect(result.stdout.trim()).toBe("0\t0\t89");
  });

  it("投稿者が読めないスレッドは除外に使わない", () => {
    // 消えたアカウントは author が空で返る。**分からないものを「要求された」に倒さない**
    // （originalCommit が無い場合と同じ判断）
    const result = runWithFiles(
      [row("bin/loop-claim", false, 40, 0)],
      [thread("bin/loop-claim", REVIEWED, "-")],
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("40\t0\t0");
  });

  it("投稿者の欄が形として読めなければ失敗する", () => {
    // 列がずれたまま数えると、**除外の範囲が黙って変わる**
    const result = runWithLines({
      files: ["T\tarray"],
      threads: ["T\tarray", `P\t${REVIEWED}\tbad login!\t${b64("bin/loop-claim")}`],
    });

    expect(result.status).toBe(1);
  });
});

describe("bin/loop-fixup-lines が gh に渡す判定式", () => {
  /**
   * **式そのものを固定する。** テストかどうかを決めているのは gh 側の `--jq` で、
   * 断片の有無だけを見ていると `endswith(".test.ts") | not` のような**反転**を
   * 通してしまう（本番では通常の `.ts` がテスト扱いになり、本体行数から消える）。
   *
   * **意味は検証していない。** 判定を本物の jq へ通すには jq が要るが、
   * **開発コンテナに jq は入っていない**（`Dockerfile` が入れるのは ca-certificates /
   * curl / git / openssh-client / procps だけ）。`gh --jq` にしてあるのは
   * **`bin/loop-*` がホストでも動く必要がある**ためで（master はコンテナを使わない）、
   * テストのために jq を足すと**スクリプトが jq を呼ぶ道が開き、その前提が壊れる**。
   *
   * 代わりに、**式を書き換えたら必ずこのテストの更新が要る**形にしてある。
   * 「気づかないうちに反転していた」は起きない。
   */
  const EXPECTED_FILES_JQ = `"T\\t\\(.files | type)", (.commits[]? | "C\\t\\(.sha)"), (.files[]? | "F\\t\\(.filename | endswith(".test.ts"))\\t\\(.filename | @base64)\\t\\(.additions)\\t\\(.deletions)"), (.files[]? | select(.status == "added") | "N\\t\\(.filename | @base64)"), (.files[]? | "D\\t\\(.filename | @base64)\\t\\((.patch // "") | @base64)")`;

  /** レビュースレッドの側も同じ理由で固定する。 */
  const EXPECTED_THREADS_JQ = `"T\\t\\(.data.repository.pullRequest.reviewThreads.nodes | type)", (.data.repository.pullRequest.reviewThreads.nodes[]? | "P\\t\\((.comments.nodes[0].originalCommit.oid) // "-")\\t\\((.comments.nodes[0].author.login) // "-")\\t\\(.path | @base64)")`;

  it("判定式が想定どおりであること", () => {
    const script = readFileSync(SCRIPT, "utf8");

    const found = [...script.matchAll(/--jq '([^']*)'/g)].map((match) => match[1]);

    expect(found).toContain(EXPECTED_FILES_JQ);
    expect(found).toContain(EXPECTED_THREADS_JQ);
  });
});

describe("bin/loop-fixup-lines の files 検査", () => {
  // 2xx で返ってきても files が配列とは限らない（欠落・null・形式不正）。
  // **数えられなかったことを 0 行として返すと、ゲートが「手直し 0 行」と読んで
  // 自動マージへ進む。** 判定不能は必ず失敗側へ倒す。
  it("files が null なら失敗する", () => {
    const result = runWithLines({ files: ["T\tnull"] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("配列");
  });

  it("files が欠けていても失敗する（型は null として届く）", () => {
    const result = runWithLines({ files: ["T\tnull", row("a", false, 34, 7)] });

    expect(result.status).toBe(1);
  });

  it("files が配列でない型なら失敗する", () => {
    expect(runWithLines({ files: ["T\tobject"] }).status).toBe(1);
    expect(runWithLines({ files: ["T\tstring"] }).status).toBe(1);
  });

  it("型の行そのものが無ければ失敗する", () => {
    // gh が何も返さなかった場合。空を 0 行として通さない
    expect(runWithLines({ files: [] }).status).toBe(1);
    expect(runWithLines({ files: [row("a", false, 34, 7)] }).status).toBe(1);
  });

  it("知らない種別の行があれば失敗する", () => {
    const result = runWithLines({ files: ["T\tarray", "X\tsomething"] });

    expect(result.status).toBe(1);
  });

  it("空の配列は 0 行として受け入れる（差分が無いのは正常）", () => {
    // 同一 commit の compare は実際に {"files": []} を返す
    const result = runWithLines({ files: ["T\tarray"] });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0\t0\t0");
  });
});

describe("bin/loop-fixup-lines の入力検査", () => {
  it("引数が足りなければ使い方を出して落ちる", () => {
    const result = run([PR, REVIEWED]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("使い方");
  });

  it("PR 番号として読めないものを渡すと落ちる", () => {
    // スレッドの問い合わせに入る。番号以外を通すと別の PR を見に行きうる
    expect(run(["main", REVIEWED, HEAD]).status).toBe(2);
    expect(run(["", REVIEWED, HEAD]).status).toBe(2);
  });

  it("SHA として読めないものを渡すと落ちる", () => {
    // ブランチ名やパスを渡すと、compare の URL がそのまま別の場所を指す
    expect(run([PR, "main", HEAD]).status).toBe(2);
    expect(run([PR, REVIEWED, "../../etc/passwd"]).status).toBe(2);
    expect(run([PR, "", HEAD]).status).toBe(2);
  });

  it("会話コメント由来の短縮 SHA は受け付ける", () => {
    // bin/loop-review-commits は短縮 SHA を返すことがある
    const result = run([PR, "0f49a38", HEAD]);

    expect(result.status).not.toBe(2);
  });

  it("入力の検査は gh を呼ぶ前に終わる", () => {
    const result = run([PR, "zz", HEAD]);

    expect(result.status).toBe(2);
    expect(result.stderr).not.toContain("gh");
  });
});
