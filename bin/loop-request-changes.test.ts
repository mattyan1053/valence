/**
 * **要求を出す操作を、1 つにまとめる**（#388）。
 *
 * **順序にも、付け直しにも意味がある。** **label は錠なので先に付ける**（**コメントだけ
 * 残ると、次の周回でゲートが通る**）。**既に付いている PR へ新しい指摘を出すときは
 * 付け直す**——**新しい指摘を見た記録は、label の時刻でしか残らない。**
 *
 * **忘れても、その場では何も起きない。** **label は付いている。コメントも出ている。**
 * **壊れるのは、時刻を読む側**である——**2026-08-22 に master が実際に忘れた**（#382）。
 *
 * **本物の GitHub へは触らない。** **`gh` を差し替えて、何をどの順で頼んだかだけを見る。**
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
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

const SCRIPT = fileURLToPath(new URL("./loop-request-changes", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HEAD = "5e2a91c4d7f60b83ae15cd429f70b6d8e3a142cb";

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type Setup = {
  /** いま付いている label。**既に付いているかどうかで、付け直すかが変わる。** */
  labels?: string[];
  /** `bin/loop-head same` の答え（0 同じ / 1 動いた / **2 読めない**）。 */
  head?: 0 | 1 | 2;
  /** 何回目の label の読み取りで落ちるか（1 = 付ける前、2 = 付けたあとの確かめ）。 */
  failsOnRead?: number;
  /** `bin/loop-outside-author` の答え（**0 = 外 / 1 = ループのアカウント / 2 = 読めない**）。 */
  outside?: 0 | 1 | 2;
  /** 保留の記録（`bin/loop-parked-head record`）が落ちるか。 */
  parkedHeadFails?: boolean;
  /** 停止の記録（`bin/loop-stall`）が落ちるか。 */
  stallFails?: boolean;
  /** `gh` のどの呼び出しで落ちるか（部分一致）。 */
  failsOn?: string;
};

function sandbox(setup: Setup = {}): { dir: string; calls: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), "request-changes-"));
  sandboxes.push(dir);
  const log = join(dir, "calls.log");
  mkdirSync(join(dir, "bin"), { recursive: true });
  // **実物を、実物と同じ置き方で置く**——**隣のスクリプトは `bin/` から辿る**ので、
  // **リポジトリの実物をそのまま走らせると、隣は差し替えられない。**
  copyFileSync(SCRIPT, join(dir, "bin", "loop-request-changes"));
  chmodSync(join(dir, "bin", "loop-request-changes"), 0o755);
  writeFileSync(join(dir, "body.md"), "直してほしい\n");
  writeFileSync(join(dir, "labels"), (setup.labels ?? []).map((name) => `${name}\n`).join(""));

  writeFileSync(
    join(dir, "gh"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      ...(setup.failsOn === undefined
        ? []
        : [
            `if [[ "$*" == *${JSON.stringify(setup.failsOn)}* ]]; then`,
            '  echo "gh: 落ちました" >&2',
            "  exit 1",
            "fi",
          ]),
      // **label は覚える**——**付けたあとに読み直す口があるので、答えが動かないと
      // 「付いたことを確かめる」が確かめになっていない**（**偽物のほうが甘い**）
      `state=${JSON.stringify(join(dir, "labels"))}`,
      `reads=${JSON.stringify(join(dir, "reads"))}`,
      'if [[ "$*" == *"--json labels"* ]]; then',
      '  n=$(cat "$reads" 2>/dev/null || echo 0); n=$((n + 1)); printf \'%s\' "$n" > "$reads"',
      ...(setup.failsOnRead === undefined
        ? []
        : [
            `  if ((n == ${setup.failsOnRead})); then`,
            '    echo "gh: label を読めません" >&2',
            "    exit 1",
            "  fi",
          ]),
      '  cat "$state" 2>/dev/null',
      "  exit 0",
      "fi",
      'if [[ "$*" == *"--add-label"* ]]; then',
      '  printf \'%s\\n\' "changes-requested" >> "$state"',
      "  exit 0",
      "fi",
      'if [[ "$*" == *"--remove-label"* ]]; then',
      '  grep -vxF "changes-requested" "$state" > "$state.tmp" 2>/dev/null || :',
      '  mv -f "$state.tmp" "$state" 2>/dev/null || :',
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  // **head が動いていないかは `bin/loop-head` が答える**（判定は写さない）
  writeFileSync(
    join(dir, "bin", "loop-head"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "loop-head $*" >> ${JSON.stringify(log)}`,
      `exit ${setup.head ?? 0}`,
    ].join("\n"),
    { mode: 0o755 },
  );
  // **記録は `bin/loop-stall` が持つ**（識別子の書式もあちら）
  writeFileSync(
    join(dir, "bin", "loop-stall"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "loop-stall $*" >> ${JSON.stringify(log)}`,
      `exit ${setup.stallFails === true ? "2" : "0"}`,
    ].join("\n"),
    { mode: 0o755 },
  );
  // **著者がループの外にいるか**（判定は `bin/loop-outside-author` が持つ）
  writeFileSync(
    join(dir, "bin", "loop-outside-author"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "loop-outside-author $*" >> ${JSON.stringify(log)}`,
      `exit ${setup.outside ?? 1}`,
    ].join("\n"),
    { mode: 0o755 },
  );
  // **保留にした head の記録**（**記録できない保留は、誰も外せない**）
  writeFileSync(
    join(dir, "bin", "loop-parked-head"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "loop-parked-head $*" >> ${JSON.stringify(log)}`,
      `exit ${setup.parkedHeadFails === true ? "1" : "0"}`,
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    dir,
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
  };
}

function request(dir: string, args: string[] = ["42", HEAD, "body.md"]) {
  return spawnSync(join(dir, "bin/loop-request-changes"), args, {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
  });
}

const only = (calls: string[], needle: string) => calls.filter((line) => line.includes(needle));

describe("bin/loop-request-changes", () => {
  it("既に付いているなら、付け直す", () => {
    // **これがこの Issue の本体**である——**付け直して初めて、判断した記録になる**
    const { dir, calls } = sandbox({ labels: ["changes-requested"] });

    const done = request(dir);

    expect(done.status, `${done.stdout}\n${done.stderr}`).toBe(0);
    const label = only(calls(), "changes-requested").filter((line) => line.includes("pr edit"));
    expect(label[0], "外していない").toContain("--remove-label");
    expect(label[1], "付け直していない").toContain("--add-label");
  });

  it("付いていないなら、外しに行かない", () => {
    // **付いていない label を外そうとすると `gh` が落ちる**——**落ちた理由が
    // 「無かった」だと、次のコメントを出してよいのか読めない**
    const { dir, calls } = sandbox({ labels: [] });

    const done = request(dir);

    expect(done.status, `${done.stdout}\n${done.stderr}`).toBe(0);
    expect(only(calls(), "--remove-label"), "付いていないのに外している").toEqual([]);
    expect(only(calls(), "--add-label"), "付けていない").not.toEqual([]);
  });

  it("label を付けてから、コメントを投稿する", () => {
    // **コメントだけ残ると、次の周回でゲートが通る**（label が錠である）
    const { dir, calls } = sandbox();

    request(dir);

    const order = calls().filter(
      (line) => line.includes("--add-label") || line.includes("pr comment"),
    );
    expect(order[0], "label を先に付けていない").toContain("--add-label");
    expect(order[1], "コメントを投稿していない").toContain("pr comment");
  });

  it("head が動いていたら、何も書かない", () => {
    // **読んだ指摘は、評価した head に対するもの**である
    const { dir, calls } = sandbox({ head: 1 });

    const done = request(dir);

    expect(done.status, "動いているのに書いている").not.toBe(0);
    expect(only(calls(), "pr edit"), "label を触っている").toEqual([]);
    expect(only(calls(), "pr comment"), "コメントを投稿している").toEqual([]);
  });

  it("label を付けられなかったら、コメントを投稿しない", () => {
    const { dir, calls } = sandbox({ failsOn: "--add-label" });

    const done = request(dir);

    expect(done.status, "落ちたのに続けている").not.toBe(0);
    expect(only(calls(), "pr comment"), "label が無いのにコメントを出している").toEqual([]);
  });

  it("コメントに失敗したら、記録を残さず、どこまで進んだかを言う", () => {
    // **戻せない**（label は付いている）——**言わないと、worker が呼ばれて何も無い**
    const { dir, calls } = sandbox({ failsOn: "pr comment" });

    const done = request(dir);

    expect(done.status, "落ちたのに 0 で終わっている").not.toBe(0);
    expect(only(calls(), "loop-stall"), "出せていないのに記録している").toEqual([]);
    expect(done.stderr, "どこまで進んだかを言っていない").toMatch(/label/);
  });

  it("出せたら、待ちを記録する", () => {
    // **`awaiting-worker` が積まれないと、返事が来ないまま止まっても人が呼ばれない**
    const { dir, calls } = sandbox();

    request(dir);

    expect(only(calls(), "loop-stall")[0], "待ちを記録していない").toContain(
      `awaiting-worker:42@${HEAD}`,
    );
  });

  it("head が動いたなら、動いたと記録する", () => {
    // **`bin/loop-head same` は 3 つ返す**（0 同じ / 1 動いた / 2 読めない）
    const { dir, calls } = sandbox({ head: 1 });

    const done = request(dir);

    expect(done.status, "出していないのに 0 で終わっている").toBe(1);
    expect(only(calls(), "loop-stall")[0], "動いたと記録していない").toContain("head-moved:42");
  });

  it("head を読めなかったなら、動いたと言わない", () => {
    // **まとめると、worker が元気に push している間ずっと取得障害が数えられない**
    // ——**人を呼ぶ道が閉じる**（`bin/loop-stall` が 2 つに分けている理由そのもの）
    const { dir, calls } = sandbox({ head: 2 });

    const done = request(dir);

    expect(done.status, "動いたときと同じ終わり方をしている").not.toBe(1);
    expect(only(calls(), "loop-stall")[0], "読めなかったと記録していない").toContain(
      "head-lookup-failed:42",
    );
    expect(only(calls(), "head-moved"), "動いたと記録している").toEqual([]);
  });

  it("label を確かめられなければ、付いたまま黙らない", () => {
    // **ここだけ、残る状態が他と違う**——**label が付いたまま、要求のコメントが無い**。
    // **受け渡しは label を見て worker を指し**、**worker は要求を探して見つけられない。**
    // **`handoff-mismatch` が拾えるのは「label が無い」ほう**なので、そちらへ倒す
    const { dir, calls } = sandbox({ failsOnRead: 2 });

    const done = request(dir);

    expect(done.status, "読めないのに続けている").not.toBe(0);
    expect(only(calls(), "pr comment"), "確かめられていないのに投稿している").toEqual([]);
    expect(only(calls(), "--remove-label"), "拾えない状態のままにしている").not.toEqual([]);
    expect(done.stderr, "読めなかったと言っていない").toMatch(/読め/);
  });

  it("外の著者なら、待たない", () => {
    // **著者がループの外にいるなら、待たない** (#70)——**SHA が変わらないまま
    // 3 周で `loop/STOP`**、**一人の不在が全体停止になる**
    const { dir, calls } = sandbox({ outside: 0 });

    const done = request(dir);

    expect(done.status, `${done.stdout}\n${done.stderr}`).toBe(0);
    expect(only(calls(), "awaiting-worker"), "外の著者を待っている").toEqual([]);
    expect(only(calls(), "loop-parked-head record"), "保留の head を記録していない").not.toEqual(
      [],
    );
    expect(only(calls(), "--add-label parked"), "保留にしていない").not.toEqual([]);
  });

  it("外か読めなければ、これまでどおり待つ", () => {
    // **判定不能を「外」に倒さない**——**worker の対応待ちが人待ちに化け、誰も直さない**
    const { dir, calls } = sandbox({ outside: 2 });

    request(dir);

    expect(only(calls(), "awaiting-worker"), "待ちを記録していない").not.toEqual([]);
    expect(only(calls(), "--add-label parked"), "読めないのに保留にしている").toEqual([]);
  });

  it("ループのアカウントなら、これまでどおり待つ", () => {
    // **上の 2 件が「外かどうか」で割れていることを、ここが支えている**
    const { dir, calls } = sandbox({ outside: 1 });

    request(dir);

    expect(only(calls(), "awaiting-worker"), "待ちを記録していない").not.toEqual([]);
  });

  it("保留の記録に失敗したら、保留にせず、待ちを数える", () => {
    // **記録の無い保留はステップ 2 が触らない**（**人が外すと決めた保留と区別が付かない**）
    // ——**そのまま永久に残る**
    const { dir, calls } = sandbox({ outside: 0, parkedHeadFails: true });

    request(dir);

    expect(only(calls(), "--add-label parked"), "記録できていないのに保留にしている").toEqual([]);
    expect(only(calls(), "awaiting-worker"), "数えていない").not.toEqual([]);
  });

  it("保留にできなかったら、待ちを数える", () => {
    // **ループは止まる側にあるので、これまでどおり数える**
    const { dir, calls } = sandbox({ outside: 0, failsOn: "--add-label parked" });

    request(dir);

    expect(only(calls(), "awaiting-worker"), "数えていない").not.toEqual([]);
  });

  it("数えられなかったら、そう言う", () => {
    // **人を呼ぶ道が黙って伸びる**——**この口が消しに来たものと同じ向き**である
    const { dir } = sandbox({ head: 1, stallFails: true });

    const done = request(dir);

    expect(done.stderr, "数えられなかったことを言っていない").toMatch(/記録できません|数えられ/);
  });

  it("本文のファイルが無ければ、何も書かない", () => {
    // **投稿の直前で落ちると、label だけが付く**
    const { dir, calls } = sandbox();

    const done = request(dir, ["42", HEAD, "居ない.md"]);

    expect(done.status, "無い本文で出している").not.toBe(0);
    expect(only(calls(), "pr edit"), "label を触っている").toEqual([]);
  });
});

describe("master の手順が、この口を通っている", () => {
  const procedure = readFileSync(join(REPO_ROOT, "loop/procedure/master.md"), "utf8");

  it("要求を出すところが、コマンドを呼ぶ形になっている", () => {
    // **手順書に手順が残っていると、写した側が古くなる**（#388 の完了条件）
    expect(procedure, "コマンドを呼んでいない").toContain("bin/loop-request-changes");
  });

  it("生の手順が残っていない", () => {
    // **残っていると、そちらを打つ人が出る**——**忘れるのは、打つ手順があるから**である
    expect(
      procedure.split("\n").filter((line) => line.includes("--add-label changes-requested")),
      "生の label 操作が残っている",
    ).toEqual([]);
  });
});
