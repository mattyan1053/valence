import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { holdLock } from "../test/held-lock.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

function script(name: string): string {
  return join(REPO_ROOT, "bin", name);
}

/**
 * 入口（`bin/loop-lease acquire`）を飛ばした周回を、**出口より前に**捕まえる（#161）。
 *
 * **記録が増えないことだけを見て緑にしない。** いまも増えていないので、
 * **何もしなくても緑になる**——**飛ばした周回を実際に作って**確かめる。
 *
 * **止めない。** #157 の判断を覆さない——**止めていたら #159 の特定が止まっていた**。
 *
 * **見るのは「誰かが持っているか」ではなく「この周回が持っているか」である。**
 * 前の版は前者だったので、**並行しているときだけ黙った**——**この仕組みが
 * 存在する理由がまさに並行**なので、**鳴る向きが逆**だった（master の指摘）。
 */
describe("入口を飛ばした周回", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "entry-check-"));
    expect(spawnSync("git", ["init", "--quiet", repo]).status).toBe(0);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function run(
    command: string,
    args: string[],
    extraPath?: string,
  ): { status: number; stdout: string; stderr: string } {
    const result = spawnSync(command, args, {
      cwd: repo,
      encoding: "utf8",
      env: extraPath ? { ...process.env, PATH: `${extraPath}:${process.env.PATH}` } : process.env,
    });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  function lease(...args: string[]): { status: number; stdout: string; stderr: string } {
    return run(script("loop-lease"), args);
  }

  function record(): string {
    const path = join(repo, ".git", "valence-loop-lease-missing");
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }

  /** `gh` を呼ばせない。**見たいのは入口の確認だけ**で、GitHub の中身ではない。 */
  function ghStub(): string {
    const stub = join(repo, "stub");
    mkdirSync(stub, { recursive: true });
    writeFileSync(join(stub, "gh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    return stub;
  }

  it("持っていなければ、その場で言う", () => {
    const checked = lease("check");

    expect(checked.stderr, "飛ばしたことを言っていない").toMatch(/lease/);
    expect(record(), "記録に残っていない").toContain("\t");
  });

  it("止めない", () => {
    // **気づける形は保ったまま、飛ばしにくくする。** 止めると、
    // **その周回でやろうとしていた調査ごと止まる**（#158 で実際にそうなりかけた）
    expect(lease("check").status).toBe(0);
  });

  it("自分で取っていれば、何も言わない", () => {
    // **cron の周回・人が直接叩く場合に邪魔しない**
    expect(lease("acquire", "worker").status).toBe(0);

    const checked = lease("check");

    expect(checked.stderr).toBe("");
    expect(record()).toBe("");
  });

  it("別のセッションから取ると、印が変わる", () => {
    // **印が周回ごとに変わらなければ、下の判定は何も見ていないのと同じ**である。
    // **別セッションで実際に取らせて**（`setsid`）、印が違うことを見る
    expect(lease("acquire", "worker").status).toBe(0);
    const mine = owner();

    rmSync(leaseFile(), { force: true });
    expect(run("setsid", [script("loop-lease"), "acquire", "worker"]).status).toBe(0);

    expect(mine, "自分の印が空である").not.toBe("");
    expect(owner(), "別のセッションでも同じ印になっている").not.toBe(mine);
  });

  it("別の周回が持っているときこそ、黙らない", () => {
    // **ここが本命である。** 「誰かが持っている」で黙ると、
    // **並行しているときだけ黙る**——**この仕組みが存在する理由がまさに並行**で、
    // **過去に 40 往復溶かした形**（レビュー要求が同時に 2 件出て枠を使い切る）が
    // **見逃される側に落ちる**。
    //
    // **印だけを別の周回のものに差し替える。** `setsid` で取らせると
    // **印の種類まで変わる**（親をたどれる／たどれないで測るものが違う）ので、
    // **「種類が違う＝分からない」の側に落ちて、この判定を 1 度も通らない**——
    // ここで見たいのは**同じ測り方で値が違うとき**である
    expect(lease("acquire", "worker").status).toBe(0);
    const state = leaseFile();
    const [first = "", mine = ""] = readFileSync(state, "utf8").split("\n");
    writeFileSync(state, `${first}\n${mine.split(":")[0]}:999999:1\n`);

    const checked = lease("check");

    expect(checked.stderr, "別の周回が持っているのに黙っている").toMatch(/lease/);
    expect(record(), "何が起きていたのかが記録に残っていない").toContain("別の周回が保持中");
  });

  /** いま記録されている持ち主の印（**2 行目**。1 行目は前の版が読む形のまま）。 */
  function owner(): string {
    return readFileSync(leaseFile(), "utf8").split("\n")[1] ?? "";
  }

  it("役を当てない", () => {
    // **`bin/loop-review-head` も `bin/loop-claim` も、master と worker の両方が使う。**
    // 役を書き固めると、**正常な master の周回のたびに「worker が飛ばした」と記録が増える**——
    // **上限 20 件なので、偽物が本物を押し出す**（master の指摘）。
    //
    // **見るのは「この周回が、どれかの役の lease を自分として持っているか」**だけである
    expect(lease("acquire", "master").status).toBe(0);

    const checked = lease("check");

    expect(checked.stderr, "master の周回に worker の飛ばしを言っている").toBe("");
    expect(record(), "偽の記録が積まれている").toBe("");
  });

  it("判定できないときは、記録しない", () => {
    // **偽の記録より、取りこぼしのほうが安い。** この記録は
    // **「同じ癖が続いていること」を読むためのもの**なので、**汚れると読めなくなる**。
    //
    // 印を持たない lease（この仕組みより前に取られたもの）は、
    // **持ち主が自分かどうか分からない**——**分からないものを飛ばしと呼ばない**
    expect(lease("acquire", "worker").status).toBe(0);
    const state = leaseFile();
    // **印の行だけを落とす**（この仕組みより前の版が書いた lease と同じ形になる）
    writeFileSync(state, `${readFileSync(state, "utf8").split("\n")[0]}\n`);

    const checked = lease("check");

    expect(checked.stderr, "分からないものを飛ばしと呼んでいる").toBe("");
    expect(record(), "分からないものを記録している").toBe("");
  });

  /** その作業場の worker の lease ファイル。 */
  function leaseFile(): string {
    const dir = join(repo, ".git");
    const found = readdirSync(dir).find(
      (entry) => entry.startsWith("valence-loop-lease-worker") && !entry.includes(".lock"),
    );
    if (found === undefined) {
      throw new Error("lease ファイルが見つからない");
    }
    return join(dir, found);
  }

  it("前の版が読める形のまま、印を足す", () => {
    // **実際に踏んだ。** 印を 3 列目に足したところ、**前の版が lease を読めなくなった**——
    // `IFS=$'\t' read -r held_token held_since` は**残り全部を 2 つ目へ入れる**ので、
    // **時刻が数値に見えなくなり `[FAIL] lease の記録を読めません`** になる。
    //
    // **lease のファイルは版をまたいで共有される。** master は worktree で
    // `origin/main` の版を走らせ、worker はブランチの版を走らせる——
    // **マージされるまでの間、両方が同じファイルを読む**。**そこで落ちると、
    // 直列化そのものが働かない**（実測では `bin/loop-handoff` が exit 2 を受け取った）。
    //
    // **1 行目は変えない。** 印は 2 行目に置く——**前の版は 1 行目しか読まない**
    expect(lease("acquire", "worker").status).toBe(0);

    const lines = readFileSync(leaseFile(), "utf8").split("\n");

    expect(lines[0]?.split("\t"), "前の版が読めない形になっている").toHaveLength(2);
    expect(lines[1], "印が残っていない").toMatch(/^[ps]:/);
  });

  it("記録は増え続けない", () => {
    // **誰が読み、誰が消すのか。** 読むのは `./task loop:status`、
    // **古いものから畳むのはここ**である——**増え続けるだけの記録は、
    // 読む気を失わせるぶん、無いのと同じ**になる
    for (let round = 0; round < 25; round++) {
      lease("check");
    }

    const lines = record().split("\n").filter(Boolean);

    expect(lines.length, "際限なく積んでいる").toBeLessThanOrEqual(20);
    expect(lines.length, "畳みすぎている").toBeGreaterThan(1);
  });

  it("記録の書き換えを、他の周回と直列にする", () => {
    // **この記録は役をまたいで共有される**（`$common_dir` に 1 つ）が、
    // **lease のロックは役ごと**なので**互いを止めない**。
    // `追記 → tail → 置換` がロックの外にあると、**片方の 1 行が消える**——
    // **飛ばすのは並行しているときに起きやすい**ので、
    // **いちばん起きてほしくないときに、いちばん起きやすい**（master の指摘）。
    //
    // **取れなかったら言う。** 黙って落とすと、`./task loop:status` から見て
    // **「飛ばしていない」と同じ**になる
    const held = holdLock({
      dir: repo,
      lock: join(repo, ".git", "valence-loop-lease-missing.lock"),
      limitSeconds: 20,
    });
    try {
      const checked = spawnSync(script("loop-lease"), ["check"], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, LOOP_LEASE_LOCK_WAIT_SEC: "1" },
      });

      expect(checked.stderr, "記録できなかったことを言っていない").toMatch(/記録/);
      expect(checked.status, "記録できないことで止めている").toBe(0);
    } finally {
      held.release();
    }
  });

  it("周回の中で使うスクリプトが、出口より前に確かめる", () => {
    // **出口だけだと、気づくのは終わったあと**——**その周回の直列化は既に効いていない**。
    // **周回で最初に触るもの**が確かめれば、**やり直せるうちに分かる**。
    //
    // **「必ず呼ばれるもの」は 1 つに決められない**（#143 で確かめた——
    // `bin/loop-gate` は open PR が 0 件の周回では呼ばれない）ので、
    // **周回中に触りうるものすべて**に置く。**どれか 1 つでも通れば捕まる**
    for (const name of ["loop-claim", "loop-gate", "loop-review-head", "loop-handoff"]) {
      expect(read(`bin/${name}`), `${name} が入口を確かめていない`).toMatch(/loop-lease" check/);
    }
  });

  it("正常な master の周回では、どのスクリプトも記録を増やさない", () => {
    // **文字列を見るだけでは、役が固定されていても緑になる**（master の指摘）。
    // **master の役で実際に走らせて、記録が増えないこと**を見る。
    //
    // **`bin/loop-claim audit` は master の周回の出口で毎回走る**ので、
    // **`bin/loop-review-head` より頻度が高い**——**master が数周回れば上限を埋め切る**
    expect(lease("acquire", "master").status).toBe(0);
    const stub = ghStub();

    run(script("loop-review-head"), ["99", "aaaaaaaa"], stub);
    run(script("loop-claim"), ["audit"], stub);

    expect(record(), "正常な master の周回で偽の記録が積まれている").toBe("");
  });

  it("判定は 1 箇所に置く", () => {
    // **同じ判定を 2 箇所に持つと、片方だけ直して食い違う**（#159 で踏んだ）
    expect(read("bin/loop-handoff"), "出口が自前で判定している").not.toContain(
      "入口の acquire を飛ばした可能性",
    );
  });
});
