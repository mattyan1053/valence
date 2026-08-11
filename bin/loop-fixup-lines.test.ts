import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-fixup-lines", import.meta.url));

const PR = "124";
const REVIEWED = "a".repeat(40);
const HEAD = "b".repeat(40);

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
  /** compare が返す行（`T\t<型>` と `F\t…`）。 */
  files: string[];
  /** レビュースレッドの取得が返す行（`T\t<型>` と `P\t…`）。 */
  threads?: string[];
  compareExit?: number;
  threadsExit?: number;
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
      '    require "--jq" "reviewThreads" ".path" "@base64" "pageInfo"',
      ...emit(fake.threads ?? ["T\\tarray"]).map((line) => `    ${line}`),
      `    exit ${fake.threadsExit ?? 0}`,
      "    ;;",
      "  *)",
      // **--jq の式まで見る。** ファイル名を符号化しているのは gh 側の --jq なので、
      // ここを見ないと **@base64 を外しても緑のまま**になる
      // **判定の式まで見る。** テストかどうかを決めているのは gh 側の --jq なので、
      // ここを見ないと **判定を外しても緑のまま**になる
      '    require "--jq" ".filename" \'endswith(".test.ts")\' "@base64" ".additions" ".deletions"',
      ...emit(fake.files).map((line) => `    ${line}`),
      `    exit ${fake.compareExit ?? 0}`,
      "    ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const result = spawnSync(SCRIPT, [PR, REVIEWED, HEAD], {
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

/** レビュースレッドが 1 件以上あるパスを表す行。 */
function thread(path: string): string {
  return `P\t${b64(path)}`;
}

/** files が配列だったとき（正常）の出力を作る。 */
function runWithFiles(rows: string[], threads: string[] = []): Run {
  return runWithLines({
    files: ["T\tarray", ...rows],
    threads: ["T\tarray", ...threads],
  });
}

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
      threads: ["T\tarray", "P\tbin/loop-claim"],
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
  const EXPECTED_FILES_JQ = `"T\\t\\(.files | type)", (.files[]? | "F\\t\\(.filename | endswith(".test.ts"))\\t\\(.filename | @base64)\\t\\(.additions)\\t\\(.deletions)")`;

  /** レビュースレッドの側も同じ理由で固定する。 */
  const EXPECTED_THREADS_JQ = `"T\\t\\(.data.repository.pullRequest.reviewThreads.nodes | type)", (.data.repository.pullRequest.reviewThreads.nodes[]? | "P\\t\\(.path | @base64)")`;

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
