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
 * **`gh api graphql --jq` が返す形**（`item<US><番号><US><更新時刻>` と `label<US><名前>`）。
 *
 * **label は 1 行ずつ**である（#550。#675 のレビュー）——**繋いでから探すと、
 * カンマを含む label 名が部分一致で当たる。**
 *
 * **`--jq` には判定を持たせない**（**形を整えるだけ**）——**持たせると、
 * どの label を外すかが試験の外へ出る**（**stub は素通しなので、何も見ていないことになる**）。
 */
const US = "\u001f";

function itemsRecords(items: readonly Item[]): string {
  return items
    .flatMap((item) => [
      `item${US}${item.number}${US}${new Date((NOW - item.hoursAgo * 3600) * 1000).toISOString()}`,
      ...(item.labels ?? []).map((name) => `label${US}${name}`),
    ])
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
        ...(world.listFails === true ? ['if [[ $args == *"graphql"* ]]; then exit 1; fi'] : []),
        // **リポジトリは実行時に決める**（§1）
        'if [[ $args == *"repo view"* ]]; then',
        "  printf 'acme\\nweb\\n'",
        "  exit 0",
        "fi",
        // **既に立っているか**（**同じことを何度も立てない**）
        'if [[ $args == *"issue list"* && $args == *"--search"* ]]; then',
        `  printf '%s' ${JSON.stringify((world.reported ?? []).map((n) => `${n}\n`).join(""))}`,
        "  exit 0",
        "fi",
        'if [[ $args == *"issues(states:OPEN"* ]]; then',
        `  printf '%b\\n' ${JSON.stringify(itemsRecords(world.issues ?? []))}`,
        "  exit 0",
        "fi",
        'if [[ $args == *"pullRequests(states:OPEN"* ]]; then',
        `  printf '%b\\n' ${JSON.stringify(itemsRecords(world.prs ?? []))}`,
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

  it("カンマを含む label 名を、部分一致で読まない", () => {
    // **GitHub の label 名にはカンマを入れられる**（#550。#675 のレビュー）
    // ——**繋いでから探すと、`foo,ready,bar` という 1 つの label が `ready` に当たる**
    const result = run({
      issues: [{ number: 1, hoursAgo: 99, labels: ["foo,ready,bar"] }],
      prs: [],
    });

    expect(result.status, "付いていない `ready` を、付いていると読んでいる").toBe(0);
  });

  it("カンマを含む label 名で、本物の待ちでないものを外さない", () => {
    // **逆側**——**`foo,parked,bar` を「保留」と読むと、止まっているのに黙る**
    const result = run({
      issues: [{ number: 1, hoursAgo: 99, labels: ["ready", "foo,parked,bar"] }],
      prs: [],
    });

    expect(result.status, "止まっているのに黙っている").toBe(1);
  });

  it("一覧は、ページの終わりまで辿る", () => {
    // **`--limit N` は「最大 N 件」**（#328 のレビュー。#675 のレビュー）
    // ——**窓で切ると、古い `ready` が検査の外へ出て「静かでよい」へ倒れる**
    //
    // **stub が `gh` そのもの**なので、**ページの送り自体はここでは動かせない**
    // （**送るのは `gh --paginate`**）。**確かめるのは 2 つ**——
    // **問い合わせが続きを辿れる形か**と、**件数で打ち切っていないか**である。
    const result = run({ issues: [{ number: 1, hoursAgo: 99, labels: ["ready"] }] });

    expect(result.asked, "ページを辿る問い合わせをしていない").toContain("--paginate");
    expect(result.asked, "続きの場所を渡していない").toContain("after:$endCursor");
    expect(result.asked, "続きがあるかを聞いていない").toContain("pageInfo");
    expect(result.asked, "件数で打ち切っている").not.toContain("--limit");
    expect(result.status).toBe(1);
  });

  it("窓より多くても、最後の 1 件まで見る", () => {
    // **打ち切りは、いちばん見たい状態で効く**——**新しいものだけが返り、
    // 古い `ready` が落ちると、止まっているのに「静かでよい」へ倒れる。**
    // **200 件ちょうどでは落ちない**ので、**超える数で置く。**
    const many: Item[] = [
      ...Array.from({ length: 250 }, (_, index) => ({
        number: index + 1,
        hoursAgo: 1,
        labels: ["backlog"],
      })),
      { number: 999, hoursAgo: 99, labels: ["ready"] },
    ];

    const result = run({ issues: many, prs: [] });

    expect(result.status, "最後の 1 件を見ていない").toBe(1);
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
    it("立てる Issue に、状態 label を付ける", () => {
      // **付けないと、この Issue 自身がループを止める**（#675 のレビュー）
      // ——**label の無い open Issue は `unlisted-issue` として積まれ、3 周で `loop/STOP`**。
      // **`blocked` にする**——**一覧に載る 4 つの 1 つ**であり、
      // **昇格できる `backlog` でもない**ので、**`no-work` はこれまでどおり積まれる**
      const result = run({ issues: [{ number: 1, hoursAgo: 30, labels: ["ready"] }] }, [
        "--report",
      ]);

      // **本文に改行があるので、行では切れない**——**`issue create` から先を見る**
      const created = result.asked.slice(result.asked.indexOf("issue create"));
      expect(created, "一覧に載らない Issue を立てている").toContain("--label blocked");
      // **`ready` にしない**——**worker が実装しに来る**（**何を実装するのか、が無い**）
      expect(created, "worker が実装しに来る label を付けている").not.toContain("--label ready");
    });

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
