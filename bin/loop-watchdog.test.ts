import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-watchdog", import.meta.url));

/** **いま**。**判定は時刻の差だけで決まる**ので、外から渡せないと確かめようがない。 */
const NOW = 1789052740;

/** 見張りが見る 1 件。 */
type Item = {
  number: number;
  /** 何時間前に動いたか。 */
  hoursAgo: number;
  labels?: string[];
};

/**
 * **`gh --jq` が返す形**（`<番号>\t<更新時刻>\t<ラベル,…>`）。
 *
 * **`--jq` には判定を持たせない**（**形を整えるだけ**）——**持たせると、
 * どのラベルを外すかが試験の外へ出る**（**stub は素通しなので、何も見ていないことになる**）。
 */
function itemsTsv(items: readonly Item[]): string {
  return items
    .map(
      (item) =>
        `${item.number}\t${new Date((NOW - item.hoursAgo * 3600) * 1000).toISOString()}\t${(
          item.labels ?? []
        ).join(",")}`,
    )
    .join("\n");
}

describe("bin/loop-watchdog", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "loop-watchdog-"));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  type World = {
    issues?: readonly Item[];
    prs?: readonly Item[];
    /** 既に立っている「止まっています」の Issue。 */
    reported?: readonly number[];
    /** GitHub を読めない。 */
    listFails?: boolean;
    /** Issue を立てられない。 */
    createFails?: boolean;
  };

  function run(world: World, args: readonly string[] = []) {
    const stub = join(sandbox, "stub");
    const calls = join(sandbox, "gh.calls");
    spawnSync("mkdir", ["-p", stub]);
    writeFileSync(
      join(stub, "gh"),
      [
        "#!/usr/bin/env bash",
        'args="$*"',
        `printf '%s\\n' "$args" >> ${JSON.stringify(calls)}`,
        ...(world.listFails === true ? ['if [[ $args == *" list"* ]]; then exit 1; fi'] : []),
        // **既に立っているか**（**同じことを何度も立てない**）
        'if [[ $args == *"issue list"* && $args == *"--search"* ]]; then',
        `  printf '%s' ${JSON.stringify((world.reported ?? []).map((n) => `${n}\n`).join(""))}`,
        "  exit 0",
        "fi",
        'if [[ $args == *"issue list"* ]]; then',
        // **`%b` で出す**——**`%s` は `\\t` をそのまま出す**ので、**タブで割れない**
        `  printf '%b\\n' ${JSON.stringify(itemsTsv(world.issues ?? []))}`,
        "  exit 0",
        "fi",
        'if [[ $args == *"pr list"* ]]; then',
        `  printf '%b\\n' ${JSON.stringify(itemsTsv(world.prs ?? []))}`,
        "  exit 0",
        "fi",
        'if [[ $args == *"issue create"* ]]; then',
        ...(world.createFails === true ? ["  exit 1"] : []),
        "  printf 'https://example.invalid/1\\n'",
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const result = spawnSync(SCRIPT, args, {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${stub}:${process.env.PATH ?? ""}`,
        LOOP_WATCHDOG_NOW: String(NOW),
      },
    });
    let asked = "";
    try {
      asked = readFileSync(calls, "utf8");
    } catch {
      asked = "";
    }
    return { ...result, asked, out: `${result.stdout}${result.stderr}` };
  }

  it("動くべき仕事が 1 つも無ければ、鳴らない", () => {
    // **`ready` が尽きた夜に鳴ると、そのうち読まれなくなる**（#248）
    const result = run({ issues: [{ number: 1, hoursAgo: 99, labels: ["backlog"] }], prs: [] });

    expect(result.status).toBe(0);
  });

  it("仕事が動いていれば、鳴らない", () => {
    const result = run({
      issues: [{ number: 1, hoursAgo: 40, labels: ["in-progress"] }],
      prs: [{ number: 2, hoursAgo: 1 }],
    });

    expect(result.status).toBe(0);
  });

  it("仕事があるのに、どれも動いていなければ、止まっていると言う", () => {
    // **実測: 3 つの作業場が 30.6 時間そろって無音だった**（#670）
    const result = run({
      issues: [{ number: 1, hoursAgo: 30.6, labels: ["ready"] }],
      prs: [{ number: 2, hoursAgo: 31 }],
    });

    expect(result.status).toBe(1);
    expect(result.out, "どれだけ止まっているかが出ていない").toMatch(/30\.6|30 時間|時間/);
  });

  it("止まっているのが正しいものは、数えない", () => {
    // **人待ち・保留・条件待ちは、動かないほうが正しい**
    for (const label of ["blocked", "parked", "awaiting-human", "waiting-condition"]) {
      const result = run({
        issues: [{ number: 1, hoursAgo: 99, labels: ["ready", label] }],
        prs: [{ number: 2, hoursAgo: 99, labels: [label] }],
      });

      expect(result.status, label).toBe(0);
    }
  });

  it("読めなかったものを「無かった」と言わない", () => {
    // **0 件に見えると、止まっているのに「静かでよい」へ倒れる**
    const result = run({ listFails: true });

    expect(result.status).toBe(2);
    expect(result.asked, "読めていないのに Issue を立てている").not.toContain("issue create");
  });

  it("境目のちょうどでは鳴らさない（過ぎてから鳴る）", () => {
    const fresh = run({ issues: [{ number: 1, hoursAgo: 12, labels: ["ready"] }] });
    const stale = run({ issues: [{ number: 1, hoursAgo: 12.5, labels: ["ready"] }] });

    expect(fresh.status).toBe(0);
    expect(stale.status).toBe(1);
  });

  it("見る時間は、外から変えられる", () => {
    const result = run({ issues: [{ number: 1, hoursAgo: 3, labels: ["ready"] }] }, [
      "--hours",
      "2",
    ]);

    expect(result.status).toBe(1);
  });

  describe("--report", () => {
    it("止まっていたら、人に届く形で残す", () => {
      const result = run({ issues: [{ number: 1, hoursAgo: 30, labels: ["ready"] }] }, [
        "--report",
      ]);

      expect(result.status).toBe(1);
      expect(result.asked, "Issue を立てていない").toContain("issue create");
    });

    it("同じことを 2 度立てない", () => {
      // **2 時間ごとに走る**——**毎回立てると、そのうち読まれなくなる**（#248）
      const result = run(
        { issues: [{ number: 1, hoursAgo: 30, labels: ["ready"] }], reported: [700] },
        ["--report"],
      );

      expect(result.status).toBe(1);
      expect(result.asked, "既に立っているのに、もう 1 つ立てている").not.toContain("issue create");
    });

    it("動いているときは、何も立てない", () => {
      const result = run({ issues: [{ number: 1, hoursAgo: 1, labels: ["ready"] }] }, ["--report"]);

      expect(result.status).toBe(0);
      expect(result.asked).not.toContain("issue create");
    });

    it("立てられなかったら、そう言う（黙って 0 で終わらない）", () => {
      const result = run(
        { issues: [{ number: 1, hoursAgo: 30, labels: ["ready"] }], createFails: true },
        ["--report"],
      );

      expect(result.status, "立てられなかったのに、止まっていることまで消えている").toBe(2);
    });
  });
});
