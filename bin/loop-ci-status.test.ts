import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-ci-status", import.meta.url));

/** `check-runs` が返す 1 件。 */
type Check = {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: string;
  /** 何秒前に始まったか。 */
  startedAgo?: number;
};

/**
 * **CI の検査が決着したかを、`status` と `conclusion` の両方で見る** (#206)。
 *
 * **実物が 105 分止まった。** **`conclusion=success` なのに `status=in_progress` のまま**で、
 * **`gh pr checks` の `bucket` は `status` から導かれる**ので **pending と読まれた**——
 * **master は毎周回「正しく何もしない」を選び、そのたびに永久へ近づいた。**
 *
 * **止めるだけにしない。** **本当に走っている CI を止めると、#47 で塞いだ
 * 「正常に動きながら何も進まない」の逆側**——**健全な待ちを壊す**——へ倒れる。
 */
describe("bin/loop-ci-status", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "loop-ci-status-"));
    expect(spawnSync("git", ["init", "--quiet", sandbox]).status).toBe(0);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  const REQUIRED = "alpha\nbeta";

  /** `.github/workflows/` に `timeout-minutes` を置く。**閾値の出所はここ**である。 */
  function workflows(timeouts: number[]): void {
    const dir = join(sandbox, ".github", "workflows");
    mkdirSync(dir, { recursive: true });
    for (const [index, minutes] of timeouts.entries()) {
      writeFileSync(
        join(dir, `w${index}.yml`),
        [
          "jobs:",
          "  one:",
          "    runs-on: ubuntu-latest",
          `    timeout-minutes: ${minutes}`,
          "",
        ].join("\n"),
      );
    }
  }

  function run(options: {
    checks?: Check[];
    /** `gh` が落ちる。 */
    ghFails?: boolean;
    /** head を読めない。 */
    headFails?: boolean;
  }): { status: number; stdout: string; stderr: string } {
    const stub = join(sandbox, "stub");
    mkdirSync(stub, { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    const tail = (check: Check) =>
      [
        check.status,
        check.conclusion ?? "",
        check.startedAgo === undefined
          ? ""
          : new Date((now - check.startedAgo) * 1000).toISOString(),
      ].join("\\u001f");
    // **符号化するのは gh 側の `--jq` である。** **スタブが常に符号化すると、
    // 実装から `@base64` を外す変異が緑のまま通る**（#135 と同じ理由）——
    // **式に `@base64` があるかを見て、無ければ生の名前を返す。**
    const encoded = (options.checks ?? []).map(
      (check) => `${Buffer.from(check.name, "utf8").toString("base64")}\\u001f${tail(check)}`,
    );
    const raw = (options.checks ?? []).map((check) => `${check.name}\\u001f${tail(check)}`);
    writeFileSync(
      join(stub, "gh"),
      [
        "#!/usr/bin/env bash",
        'args="$*"',
        // **`--jq` の式まで見る**（#135 と同じ理由）——**スタブが「取り出し済みの値」を
        // 返すだけだと、問い合わせる列を変えても緑のまま**になる
        'if [[ $args == *"headRefOid"* ]]; then',
        ...(options.headFails === true ? ["  exit 1"] : []),
        `  printf '%s\\n' "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"`,
        "  exit 0",
        "fi",
        'if [[ $args == *"check-runs"* ]]; then',
        ...(options.ghFails === true ? ["  exit 1"] : []),
        '  if [[ $args != *".conclusion"* ]]; then',
        '    echo "スタブ: conclusion を問い合わせていない: $args" >&2',
        "    exit 1",
        "  fi",
        '  if [[ $args != *".status"* ]]; then',
        '    echo "スタブ: status を問い合わせていない: $args" >&2',
        "    exit 1",
        "  fi",
        '  if [[ $args == *"@base64"* ]]; then',
        ...encoded.map((row) => `    printf '%b\\n' ${JSON.stringify(row)}`),
        "  else",
        ...raw.map((row) => `    printf '%b\\n' ${JSON.stringify(row)}`),
        "  fi",
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const copied = join(sandbox, "loop-ci-status");
    writeFileSync(copied, "");
    rmSync(copied);
    const bin = join(sandbox, "bin");
    mkdirSync(bin, { recursive: true });
    const target = join(bin, "loop-ci-status");
    writeFileSync(target, "");
    rmSync(target);
    spawnSync("cp", [SCRIPT, target]);
    chmodSync(target, 0o755);
    const result = spawnSync(target, ["42"], {
      cwd: sandbox,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${stub}:${process.env.PATH}`,
        LOOP_REQUIRED_CHECKS: REQUIRED,
      },
    });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  it("conclusion が出ていれば、status が in_progress でも決着として扱う", () => {
    // **実物がこれである**（105 分）。**`status` と `conclusion` は別の軸**なので、
    // **片方に丸めない**（#90「並べ忘れた値がどの分岐にも入らない」と同族）
    workflows([5, 20]);

    const result = run({
      checks: [
        { name: "alpha", status: "in_progress", conclusion: "success", startedAgo: 6300 },
        { name: "beta", status: "completed", conclusion: "success", startedAgo: 6300 },
      ],
    });

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it("本当に走っている検査は、これまでどおり待つ", () => {
    // **止める側だけ見ると、健全な CI を止める形でも緑になる**
    //（#200 で 3 回出た「倒す先は 2 つある」）
    workflows([5, 20]);

    const result = run({
      checks: [
        { name: "alpha", status: "in_progress", startedAgo: 60 },
        { name: "beta", status: "completed", conclusion: "success", startedAgo: 60 },
      ],
    });

    expect(result.status, "走っている CI を止めている").toBe(3);
  });

  it("決着しないまま予算を超えたら、人を呼ぶ", () => {
    // **ジョブ自身が諦める時間より長く待つ理由が無い**（閾値の根拠）
    workflows([5, 20]);

    const result = run({
      checks: [
        { name: "alpha", status: "in_progress", startedAgo: 21 * 60 },
        { name: "beta", status: "completed", conclusion: "success", startedAgo: 21 * 60 },
      ],
    });

    expect(result.status, "永久に待っている").toBe(4);
  });

  it("予算は、いちばん長い timeout-minutes に合わせる", () => {
    // **短いほうに合わせると、長い CI を持つ検査で誤って止める**（master の指摘）。
    // **16 分は `ci.yml` の 15 分を超えるが、`codeql.yml` の 20 分の内**である
    workflows([5, 15, 20]);

    const result = run({
      checks: [
        { name: "alpha", status: "in_progress", startedAgo: 16 * 60 },
        { name: "beta", status: "completed", conclusion: "success", startedAgo: 16 * 60 },
      ],
    });

    expect(result.status, "短いほうの timeout で止めている").toBe(3);
  });

  it("予算を読めなければ、待つ側へ倒す", () => {
    // **判定不能を「止める」へ倒さない**（完了条件）
    const result = run({
      checks: [
        { name: "alpha", status: "in_progress", startedAgo: 100000 },
        { name: "beta", status: "completed", conclusion: "success", startedAgo: 100000 },
      ],
    });

    expect(result.status, "根拠が無いまま止めている").toBe(3);
  });

  it("始まった時刻を読めなければ、待つ側へ倒す", () => {
    workflows([5]);

    const result = run({
      checks: [
        { name: "alpha", status: "queued" },
        { name: "beta", status: "completed", conclusion: "success", startedAgo: 10 },
      ],
    });

    expect(result.status, "経過を測れないのに止めている").toBe(3);
  });

  it("決着して失敗なら、待たずに失敗を返す", () => {
    workflows([5]);

    const result = run({
      checks: [
        { name: "alpha", status: "completed", conclusion: "failure", startedAgo: 10 },
        { name: "beta", status: "completed", conclusion: "success", startedAgo: 10 },
      ],
    });

    expect(result.status, "失敗を待ちに混ぜている").toBe(1);
  });

  it("知らない conclusion は、成功に数えない", () => {
    // **並べ忘れた値がどの分岐にも入らない**を避ける（#90）——
    // **成功の側を並べ、それ以外は失敗**へ倒す
    workflows([5]);

    const result = run({
      checks: [
        { name: "alpha", status: "completed", conclusion: "timed_out", startedAgo: 10 },
        { name: "beta", status: "completed", conclusion: "success", startedAgo: 10 },
      ],
    });

    expect(result.status, "知らない値を成功として通している").toBe(1);
  });

  it("区切りを含む名前で、必須の検査を偽装できない", () => {
    // **チェック名は PR 側で決められる**（pull_request で走る job 名）。
    // **生のまま並べる実装では、名前 1 つで行を増やし、実在しない必須チェックを
    // 成功に見せられる**——**符号化した名前で突き合わせる。**
    workflows([5]);

    const result = run({
      checks: [
        {
          // **生のまま並べる実装では、この名前 1 つで `alpha` の行が増える**
          name: "dummy\nalpha\u001fcompleted\u001fsuccess\u001f2026-01-01T00:00:00Z",
          status: "completed",
          conclusion: "success",
          startedAgo: 10,
        },
        { name: "beta", status: "completed", conclusion: "success", startedAgo: 10 },
      ],
    });

    expect(result.status, "名前で必須チェックを偽装できている").toBe(1);
  });

  it("必須の検査が無ければ、待たずに失敗を返す", () => {
    // **ワークフローが起動しなかった PR を、0 件で通さない**
    workflows([5]);

    const result = run({
      checks: [{ name: "alpha", status: "completed", conclusion: "success", startedAgo: 10 }],
    });

    expect(result.status, "必須が欠けたまま通している").toBe(1);
  });

  it("取得できなければ、止める側へ倒さない", () => {
    workflows([5]);

    const result = run({ ghFails: true });

    expect(result.status, "読めないのに人を呼んでいる").toBe(2);
  });

  it("head を読めなければ、止める側へ倒さない", () => {
    workflows([5]);

    const result = run({ headFails: true });

    expect(result.status).toBe(2);
  });
});
