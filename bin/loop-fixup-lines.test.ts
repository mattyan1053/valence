import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-fixup-lines", import.meta.url));

const REVIEWED = "a".repeat(40);
const HEAD = "b".repeat(40);

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

/**
 * gh を差し替えて、スクリプトが受け取る行をそのまま渡す。
 * 差し替えが返すのは **ファイルごとの生の行数** で、分類も合計もスクリプト側で行う。
 * ここを gh の --jq に寄せると、テストは「あらかじめ数えた答え」を渡すだけになり、
 * **数え方そのものを 1 つも検証できない**。
 *
 * `files` が配列かどうかも `T\t<型>` の 1 行として受け取る。コンテナに jq が無く、
 * 差し替えた gh は `--jq` を実行できないので、**生の JSON を渡すテストは書けない**。
 * 型を出力の一部にしてあるので、**判定そのものはここで検証できる**。
 */
function runWithLines(lines: string[], ghExit = 0): Run {
  const dir = mkdtempSync(join(tmpdir(), "loop-fixup-fake-"));
  symlinkSync("/usr/bin/bash", join(dir, "bash"));
  writeFileSync(
    join(dir, "gh"),
    [
      "#!/usr/bin/env bash",
      // %b で渡す。%s だと JSON.stringify が付けた \t が **タブに戻らず**、
      // 列の分かれていない行を渡してしまう
      ...lines.map((line) => `printf '%b\\n' ${JSON.stringify(line)}`),
      `exit ${ghExit}`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const result = spawnSync(SCRIPT, [REVIEWED, HEAD], {
    encoding: "utf8",
    env: { ...process.env, PATH: dir },
  });
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** `F\t<ファイル名>\t<追加>\t<削除>` の 1 行を作る。 */
function file(name: string, additions: number, deletions: number): string {
  return `F\t${name}\t${additions}\t${deletions}`;
}

/** files が配列だったとき（正常）の出力を作る。 */
function runWithFiles(rows: string[], ghExit = 0): Run {
  return runWithLines(["T\tarray", ...rows], ghExit);
}

describe("bin/loop-fixup-lines の数え方", () => {
  it("本体の変更は追加も削除も数える", () => {
    const result = runWithFiles([file("bin/loop-merge", 34, 7)]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("41\t0");
  });

  it("テストの追加行は数えない", () => {
    // 危険なのは「レビューを受けていない本体の変更」であって、守りが増えることではない
    const result = runWithFiles([
      file("bin/loop-merge", 34, 7),
      file("bin/loop-merge.test.ts", 43, 0),
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("41\t43");
  });

  it("テストの削除行は数える", () => {
    // 「テストファイルだから安全」ではない。**守りを減らす変更は本体と同じ**に扱う。
    // ここを追加と一緒に除外すると、レビュー後に検証を消しても素通りする
    const result = runWithFiles([file("bin/loop-merge.test.ts", 0, 30)]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("30\t0");
  });

  it("同じファイルで追加と削除が混ざっていても、削除だけを数える", () => {
    const result = runWithFiles([file("src/domain/pr.test.ts", 12, 5)]);

    expect(result.stdout.trim()).toBe("5\t12");
  });

  it("末尾が .test.ts のものだけをテストとして扱う", () => {
    // 名前に test を含むだけの本体ファイルを除外すると、**本体の変更が数から消える**
    const result = runWithFiles([
      file("src/domain/test.ts", 10, 0),
      file("src/test-utils.ts", 5, 0),
      file("bin/loop-stall.test.ts", 7, 0),
    ]);

    expect(result.stdout.trim()).toBe("15\t7");
  });

  it("変更ファイルが 0 件なら 0 を返す", () => {
    const result = runWithFiles([]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0\t0");
  });

  it("行数として読めない行があれば失敗する", () => {
    // 0 として数えると、**取得の壊れが「手直しが小さい」に化けて素通りする**
    const result = runWithFiles([file("bin/loop-merge", 34, 7), "bin/broken\tx\t3"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("読めません");
  });

  it("列が足りない行があれば失敗する", () => {
    const result = runWithFiles(["bin/loop-merge\t34"]);

    expect(result.status).toBe(1);
  });

  it("gh が失敗したら失敗として返す（0 行と扱わない）", () => {
    const result = runWithFiles([], 1);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("取得できません");
  });
});

describe("bin/loop-fixup-lines の files 検査", () => {
  // 2xx で返ってきても files が配列とは限らない（欠落・null・形式不正）。
  // **数えられなかったことを 0 行として返すと、ゲートが「手直し 0 行」と読んで
  // 自動マージへ進む。** 判定不能は必ず失敗側へ倒す。
  it("files が null なら失敗する", () => {
    const result = runWithLines(["T\tnull"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("配列");
  });

  it("files が欠けていても失敗する（型は null として届く）", () => {
    const result = runWithLines(["T\tnull", file("bin/loop-merge", 34, 7)]);

    expect(result.status).toBe(1);
  });

  it("files が配列でない型なら失敗する", () => {
    expect(runWithLines(["T\tobject"]).status).toBe(1);
    expect(runWithLines(["T\tstring"]).status).toBe(1);
  });

  it("型の行そのものが無ければ失敗する", () => {
    // gh が何も返さなかった場合。空を 0 行として通さない
    expect(runWithLines([]).status).toBe(1);
    expect(runWithLines([file("bin/loop-merge", 34, 7)]).status).toBe(1);
  });

  it("知らない種別の行があれば失敗する", () => {
    const result = runWithLines(["T\tarray", "X\tsomething"]);

    expect(result.status).toBe(1);
  });

  it("空の配列は 0 行として受け入れる（差分が無いのは正常）", () => {
    // 同一 commit の compare は実際に {"files": []} を返す
    const result = runWithLines(["T\tarray"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0\t0");
  });
});

describe("bin/loop-fixup-lines の入力検査", () => {
  it("引数が足りなければ使い方を出して落ちる", () => {
    const result = run([REVIEWED]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("使い方");
  });

  it("SHA として読めないものを渡すと落ちる", () => {
    // ブランチ名やパスを渡すと、compare の URL がそのまま別の場所を指す
    expect(run(["main", HEAD]).status).toBe(2);
    expect(run([REVIEWED, "../../etc/passwd"]).status).toBe(2);
    expect(run(["", HEAD]).status).toBe(2);
  });

  it("会話コメント由来の短縮 SHA は受け付ける", () => {
    // bin/loop-review-commits は短縮 SHA を返すことがある
    const result = run(["0f49a38", HEAD]);

    expect(result.status).not.toBe(2);
  });

  it("入力の検査は gh を呼ぶ前に終わる", () => {
    const result = run(["zz", HEAD]);

    expect(result.status).toBe(2);
    expect(result.stderr).not.toContain("gh");
  });
});
