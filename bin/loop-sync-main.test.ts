/**
 * **`main` の同期は、回数ではなく理由でやり直す** (#217)。
 *
 * **「1 度だけやり直す」は `cannot lock ref` のために置かれた**——**2 人が同時に
 * fetch して後発が負ける形**で、**やり直せば「更新するものが無い」で通る。**
 *
 * **実際に落ちたのは別の理由だった**（`Permission denied (publickey)` が 2 回）。
 * **形は同じ「2 回落ちた」だが、原因が違う**——**規則が原因を 1 つに決め打ちして
 * いたので、別の理由で落ちたときに回数だけが当てはまった。**
 *
 * **やり直してよい理由を並べ、それ以外は止める。** **失敗の側を並べると、
 * 知らない理由がどの分岐にも入らない**（#207 / #208 で繰り返し出ている形）。
 * **判定できないものは、このループでは常に止まる側**である。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-sync-main", import.meta.url));

const HEAD = "a".repeat(40);

/** 実際に踏んだ理由。**やり直しても同じなので、止まる側**である。 */
const AUTH = "git@github.com: Permission denied (publickey).";
/** 「1 度だけやり直す」が置かれた理由。**もう一方が書き終えていれば通る。** */
const RACE =
  "error: cannot lock ref 'refs/remotes/origin/main': is at 1111111 but expected 2222222";

describe("bin/loop-sync-main", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "loop-sync-main-"));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  function run(options: {
    /** `fetch` の結果を、呼ばれた順に並べる。空文字は成功。 */
    fetches: string[];
    /** `switch` が落ちる。 */
    switchFails?: boolean;
    /** スクリプトへ渡す引数。 */
    args?: string[];
  }): { status: number; stdout: string; stderr: string; fetches: number; switched: number } {
    const stub = join(sandbox, "stub");
    mkdirSync(stub, { recursive: true });
    const outcomes = join(sandbox, "outcomes");
    // 空行を潰さないよう、1 行 1 件で書き出す（成功は "-" で表す）
    writeFileSync(outcomes, `${options.fetches.map((f) => f || "-").join("\n")}\n`);
    const fetched = join(sandbox, "fetched");
    const switched = join(sandbox, "switched");

    writeFileSync(
      join(stub, "git"),
      [
        "#!/usr/bin/env bash",
        'args="$*"',
        'if [[ $args == "fetch origin main"* ]]; then',
        `  printf 'x\\n' >> ${JSON.stringify(fetched)}`,
        `  outcome="$(head -1 ${JSON.stringify(outcomes)})"`,
        `  sed -i '1d' ${JSON.stringify(outcomes)}`,
        '  if [[ $outcome == "-" ]]; then exit 0; fi',
        "  printf '%s\\n' \"$outcome\" >&2",
        "  exit 1",
        "fi",
        'if [[ $args == "switch --detach origin/main"* ]]; then',
        `  printf 'x\\n' >> ${JSON.stringify(switched)}`,
        ...(options.switchFails === true
          ? ['  echo "fatal: いまは切り替えられません" >&2', "  exit 1"]
          : ["  exit 0"]),
        "fi",
        'if [[ $args == "rev-parse HEAD"* ]]; then',
        `  printf '%s\\n' ${JSON.stringify(HEAD)}`,
        "  exit 0",
        "fi",
        'echo "スタブ: 想定外の呼び出し: $args" >&2',
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const count = (path: string) =>
      existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").length : 0;
    const result = spawnSync(SCRIPT, options.args ?? [], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
    });
    return {
      status: result.status ?? -1,
      stdout: result.stdout,
      stderr: result.stderr,
      fetches: count(fetched),
      switched: count(switched),
    };
  }

  it("1 回で通れば、やり直さない", () => {
    const result = run({ fetches: [""] });

    expect(result.status, result.stderr).toBe(0);
    expect(result.fetches, "落ちていないのに投げ直している").toBe(1);
    expect(result.stdout).toContain(HEAD);
  });

  it("ref の取り合いで負けたら、1 度だけやり直す", () => {
    // **やり直すと「更新するものが無い」で成功する**——**直っているのに赤にしない。**
    const result = run({ fetches: [RACE, ""] });

    expect(result.status, result.stderr).toBe(0);
    expect(result.fetches).toBe(2);
  });

  it("やり直しても取り合いに負けたら、そこで止める", () => {
    // **回数の上限は残す。** **理由で分けても、無限には投げない。**
    const result = run({ fetches: [RACE, RACE] });

    expect(result.status).toBe(1);
    expect(result.fetches, "3 回以上投げている").toBe(2);
  });

  it("認証で落ちたら、やり直さない", () => {
    // **何回投げても同じ**（恒久的）。**実際にここで規則を破った**——
    // **回数だけが当てはまる形になっていた。**
    const result = run({ fetches: [AUTH, ""] });

    expect(result.status).toBe(1);
    expect(result.fetches, "恒久的な失敗で投げ直している").toBe(1);
    expect(result.switched, "同期できていないのに切り替えている").toBe(0);
  });

  it("知らない理由なら、やり直さない", () => {
    // **並べるのはやり直してよい側だけ。** **知らない理由は止まる側へ落ちる**
    // ——**「漏れたものがどの分岐にも入らない」を作らない。**
    const result = run({ fetches: ["error: 何か知らないことが起きました", ""] });

    expect(result.status).toBe(1);
    expect(result.fetches).toBe(1);
  });

  it("止まるときは、理由をそのまま出す", () => {
    // **「同期できません」だけだと、次に読む者がまた一から調べる。**
    const result = run({ fetches: [AUTH] });

    expect(result.stderr).toContain("Permission denied");
  });

  it("--fetch-only は、取ってくるだけで切り替えない", () => {
    // **rebase の前は、PR の head にいたまま `origin/main` を取り直す**
    // ——**切り替えると、その PR の checkout を捨ててしまう。**
    const result = run({ fetches: [""], args: ["--fetch-only"] });

    expect(result.status, result.stderr).toBe(0);
    expect(result.switched, "切り替えてしまっている").toBe(0);
  });

  it("--fetch-only でも、理由で分ける", () => {
    // **判断は 1 つ**。**取ってくるだけの経路にも、同じ分け方が効く。**
    const result = run({ fetches: [AUTH, ""], args: ["--fetch-only"] });

    expect(result.status).toBe(1);
    expect(result.fetches, "恒久的な失敗で投げ直している").toBe(1);
  });

  it("知らない引数は受けない", () => {
    const result = run({ fetches: [""], args: ["--なにか"] });

    expect(result.status).toBe(2);
    expect(result.fetches, "使い方が違うのに取りに行っている").toBe(0);
  });

  it("切り替えに失敗したら、同期できたことにしない", () => {
    // **fetch が通っても、先端へ移れていなければ同期ではない。**
    const result = run({ fetches: [""], switchFails: true });

    expect(result.status).toBe(1);
  });
});

/**
 * **置き場所を片方だけにしない**（#216 と同じ理由）。
 *
 * **master も worker も、周回の冒頭で `main` へ同期する。** **散文で片方にだけ
 * 書くと、もう片方が同じところで詰まる**——**そして、その片方は規則を破る。**
 */
describe("同期の口は、両方の役から辿れる", () => {
  const ROOT = fileURLToPath(new URL("..", import.meta.url));

  for (const doc of [".claude/commands/loop-worker.md", ".claude/commands/loop-master.md"]) {
    it(`${doc} が同期の口を指している`, () => {
      const text = readFileSync(join(ROOT, doc), "utf8");
      expect(text).toContain("bin/loop-sync-main");
      // **書き方ではなく、残っていないことを見る** (#226 のレビュー)。
      // **合わせ技だけを探すと、別の書き方で足した 1 本が素通りする**
      // ——**実際に、マージ後の経路が前のまま残っていた。**
      expect(text, "判断を通らない fetch が残っている").not.toMatch(/git fetch origin main/);
    });
  }
});
