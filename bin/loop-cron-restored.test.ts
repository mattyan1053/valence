import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * **予定表を入れ直したことを、周回をまたいで残す** (#677)。
 *
 * **メッセージは揮発する。** **入れ直したことが記録に無いと、次に読む人は
 * 「なぜ刻みが変わったのか」を追えない**——**予定表そのものは、引いたセッションに
 * しか見えない。**
 *
 * **窓を持つ既存の記録へ足さない**（#537）。**`valence-loop-starts-*` は
 * `bin/loop-cadence` が全行を読み、行数の窓を持っている**——**別の種類の行を足すと、
 * 元からあった cron の行が押し出される。** **自分の記録を持つ。**
 */
const SCRIPT = fileURLToPath(new URL("./loop-cron-restored", import.meta.url));

describe("bin/loop-cron-restored", () => {
  let sandbox: string;
  let record: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "loop-cron-restored-"));
    expect(spawnSync("git", ["init", "--quiet", sandbox]).status).toBe(0);
    record = join(sandbox, ".git", "valence-loop-cron-restored");
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  function run(args: readonly string[], now = 1789052740) {
    return spawnSync(SCRIPT, args, {
      cwd: sandbox,
      encoding: "utf8",
      env: { ...process.env, LOOP_CRON_RESTORED_NOW: String(now) },
    });
  }

  function lines(): string[] {
    return existsSync(record)
      ? readFileSync(record, "utf8")
          .split("\n")
          .filter((line) => line !== "")
      : [];
  }

  it("入れ直したことを、いつ・どこで・どの刻みで、と残す", () => {
    const result = run(["30m"]);

    expect(result.status, result.stderr).toBe(0);
    expect(lines()).toHaveLength(1);
    const [when, where, every] = (lines()[0] ?? "").split("\t");
    expect(when).toBe("1789052740");
    expect(where, "どの作業場か分からない").toBe(sandbox);
    expect(every).toBe("30m");
  });

  it("刻みを渡さなければ、何も残さない", () => {
    // **記録の形は、あとから読む人が頼りにする**——**欠けた行を混ぜない**
    expect(run([]).status).toBe(2);
    expect(lines(), "形の違う行を残している").toHaveLength(0);
  });

  it("刻みの形が違えば、何も残さない", () => {
    for (const every of ["30", "m", "0m", "30x", "30 m", "-5m", "30m 30m"]) {
      const result = run([every]);

      expect(result.status, every).toBe(2);
      expect(lines(), every).toHaveLength(0);
    }
  });

  it("重ねて呼ぶと、下へ積む", () => {
    run(["30m"]);
    run(["45m"], 1789052800);

    expect(lines()).toHaveLength(2);
    expect(lines()[1]).toContain("45m");
  });

  it("窓を超えたら、古い行から落ちる", () => {
    // **上限まで埋めてから 1 つ入れる** (#537)——**埋めないと押し出しは起きず、
    // 「積んで数える」だけの試験では通ってしまう。**
    const window = 100;
    writeFileSync(
      record,
      `${Array.from({ length: window }, (_, index) => `${index}\t${sandbox}\t30m`).join("\n")}\n`,
    );

    run(["45m"]);

    expect(lines(), "窓が効いていない").toHaveLength(window);
    expect(lines()[0], "いちばん古い行が残っている").not.toBe(`0\t${sandbox}\t30m`);
    expect(lines()[window - 1], "入れたものが落ちている").toContain("45m");
  });

  it("--list で、残っているものを読める", () => {
    run(["30m"]);

    const result = run(["--list"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("30m");
  });

  it("1 度も入れ直していなければ、--list は言うことが無い", () => {
    const result = run(["--list"]);

    expect(result.status).toBe(1);
  });

  it("git の中でなければ、判定できないと言う", () => {
    // **黙って 0 で終わらない**——**残せていないのに「残した」に見える**
    const outside = mkdtempSync(join(tmpdir(), "loop-cron-restored-bare-"));
    try {
      const result = spawnSync(SCRIPT, ["30m"], { cwd: outside, encoding: "utf8" });

      expect(result.status).toBe(2);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
