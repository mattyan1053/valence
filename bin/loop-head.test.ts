import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-head", import.meta.url));

const EVALUATED = "a".repeat(40);
const PUSHED = "b".repeat(40);

/**
 * 評価した head が、いまも PR の head かを確かめる（#145）。
 *
 * **master は 1 周の中で head を何度も読む。** 読むたびに違いうるので、
 * **評価した head と、記録・投稿する head が食い違う**。
 *
 * **実測**（#165 の周回）: 要求を投げてから返るまでの数分に worker が push し、
 * **レビュー 2 回目の枠を、既に消えた head に使った**。指摘の本文も古い head を
 * 指していたが、**それが新しい head にも当てはまるかは誰も確かめていない**。
 *
 * **`bin/loop-merge --match-head-commit` と同じ考え方**を、記録側にも置く。
 */
describe("bin/loop-head", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "loop-head-"));
    expect(spawnSync("git", ["init", "--quiet", sandbox], { encoding: "utf8" }).status).toBe(0);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  /**
   * `gh` を差し替える。**返す head を呼び出しごとに変えられる**——
   * **ずれを作らないと、この直しは 1 度も通らない**（動いていない周回だけを見ると、
   * 何もしなくても緑になる）。
   */
  function withHead(heads: string[]): string {
    const stub = join(sandbox, "stub");
    mkdirSync(stub, { recursive: true });
    writeFileSync(
      join(stub, "gh"),
      [
        "#!/usr/bin/env bash",
        // **何回目の呼び出しかを数える。** 1 回目と 2 回目で違う head を返す
        `count="$(cat ${JSON.stringify(join(stub, "count"))} 2>/dev/null || echo 0)"`,
        `echo $((count + 1)) > ${JSON.stringify(join(stub, "count"))}`,
        `heads=(${heads.map((head) => JSON.stringify(head)).join(" ")})`,
        'index="$count"',
        "((index < ${#heads[@]})) || index=$((${#heads[@]} - 1))",
        'head="${heads[$index]}"',
        // **空文字のときは、成功しながら空を返す。** **gh はそうしうる**ので、
        // **落ちた場合と分けて確かめる**（落ちる側は別の試験が見る）
        'printf "%s\\n" "$head"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    return stub;
  }

  function run(args: string[], stub: string): { status: number; out: string } {
    const result = spawnSync(SCRIPT, args, {
      cwd: sandbox,
      encoding: "utf8",
      env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
    });
    return { status: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
  }

  it("動いていなければ、そのまま進んでよい", () => {
    const result = run(["same", "12", EVALUATED], withHead([EVALUATED]));

    expect(result.status).toBe(0);
  });

  it("周回の途中で push されたら、そうと分かる", () => {
    // **これが本命である。** 評価してから記録するまでに head が動いた状態を作る
    const result = run(["same", "12", EVALUATED], withHead([PUSHED]));

    expect(result.status, "動いたのに進んでよいと言っている").toBe(1);
    expect(result.out, "評価した head が出ていない").toContain(EVALUATED);
    expect(result.out, "いまの head が出ていない").toContain(PUSHED);
  });

  it("短縮された SHA でも比べられる", () => {
    // **ゲートは FAIL のとき head を縮めて出す。** 縮んだ値を渡されて
    // **必ず「動いた」と言う**ようだと、**動いていない周回が毎回止まる**
    const result = run(["same", "12", EVALUATED.slice(0, 8)], withHead([EVALUATED]));

    expect(result.status).toBe(0);
  });

  it("短すぎる指定は受け付けない", () => {
    // **前方一致で比べるので、短いほど何にでも当たる。**
    // **「確かめた」と言えない長さ**を、確かめたことにしない
    expect(run(["same", "12", "aaa"], withHead([EVALUATED])).status).toBe(2);
  });

  it("gh が成功しながら空を返しても、同じだと言わない", () => {
    // **判定不能を「進んでよい」に倒さない。** 倒すと、**この仕組みが塞ごうとした
    // 「確かめていないのに確かめた顔をする」**が、そのまま残る。
    //
    // **落ちた場合と分けて確かめる。** 落ちる側だけを見ていると、
    // **空を「同じ」に倒す変異が緑のまま**になる（実際にそうなった）
    expect(run(["same", "12", EVALUATED], withHead([""])).status).toBe(2);
  });

  it("PR 番号は数字だけを受け付ける", () => {
    expect(run(["same", "12x", EVALUATED], withHead([EVALUATED])).status).toBe(2);
    expect(run(["same"], withHead([EVALUATED])).status).toBe(2);
  });

  it("gh が落ちたら、同じだと言わない", () => {
    const stub = join(sandbox, "broken");
    mkdirSync(stub, { recursive: true });
    writeFileSync(join(stub, "gh"), "#!/usr/bin/env bash\nexit 1\n");
    chmodSync(join(stub, "gh"), 0o755);

    expect(run(["same", "12", EVALUATED], stub).status).toBe(2);
  });
});
