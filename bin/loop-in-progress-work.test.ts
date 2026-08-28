import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-in-progress-work", import.meta.url));

/** 列の区切り。**本物と同じ**（`bin/loop-open-work` が使っているもの）。 */
const FIELD = "\u001f";

type Pr = { number: number; branch: string; labels?: string[] };

function lines(prs: readonly Pr[]): string {
  return prs.map((pr) => [pr.number, pr.branch, ...(pr.labels ?? [])].join(FIELD)).join("\n");
}

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * **Issue のタイトルは `gh` から来る**（`bin/loop-issue-descendants` が引く）。
 *
 * **身代わりを置く**——**この機械の実物の Issue で合否を決めない**（#556 と同じ理由）。
 */
function run(issues: readonly number[], input: string, titles: Record<number, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "in-progress-work-"));
  sandboxes.push(dir);
  const listed = Object.entries(titles)
    .map(([number, title]) => `${number}\t${title}`)
    .join("\n");
  writeFileSync(
    join(dir, "gh"),
    [
      "#!/usr/bin/env bash",
      // **`%b` で出す**——**`%s` だと `\\t` が literal のまま渡り、列が割れない**
      `printf '%b' ${JSON.stringify(listed === "" ? "" : `${listed}\n`)}`,
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(join(dir, "gh"), 0o755);
  const done = spawnSync(SCRIPT, issues.map(String), {
    input,
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
  });
  return { status: done.status ?? -1, stdout: done.stdout.trim(), stderr: done.stderr };
}

const WAITING = ["parked", "awaiting-human"];

/**
 * **人待ちの PR を持つ Issue を、着手中の数に入れない**（#558。**#546 の裏側**）。
 *
 * **#546 は PR の側を引いた。** **その PR を持つ Issue は `in-progress` のまま数に
 * 入り続ける**——**両方の手が空いても `no-work` が通らず、人が呼ばれない。**
 *
 * **境目は「その Issue の open PR が、全部人待ちか」**である。**1 本でも普通の open PR が
 * あるなら、そちらを進められる。** **PR がまだ無い `in-progress` は、誰かが実装している
 * 最中**なので、**これまでどおり数に入る**（**外すと、実装中なのに「尽きた」と数える**）。
 */
describe("着手を進められる in-progress を数える", () => {
  it("PR がまだ無い Issue は、これまでどおり数える", () => {
    // **実装している最中である**——**外すと、3 周で全ループが止まる**
    expect(run([501], "").stdout).toBe("1");
  });

  it("人待ちの PR しか持たない Issue は、数えない", () => {
    // **いまの盤面がこれ**（#501 の実装は #502 で、`parked` + `awaiting-human`）
    const listed = run([501], lines([{ number: 502, branch: "fix/501-count", labels: WAITING }]));

    expect(listed.stdout, "人待ちだけなのに数えている").toBe("0");
  });

  it("普通の open PR が 1 本でもあれば、数える", () => {
    // **そちらを進められる**——**引くと、進められる作業があるのに「尽きた」と数える**
    const listed = run(
      [501],
      lines([
        { number: 502, branch: "fix/501-count", labels: WAITING },
        { number: 503, branch: "fix/501-other" },
      ]),
    );

    expect(listed.stdout, "進められる PR があるのに数えていない").toBe("1");
  });

  it("`parked` だけの PR は、進められる側である", () => {
    // **先行 PR 待ちはループが解く**（`bin/loop-open-work` の判断）
    // ——**判定を書き写していないので、そちらの境目がそのまま効く**
    const listed = run(
      [501],
      lines([{ number: 502, branch: "fix/501-count", labels: ["parked"] }]),
    );

    expect(listed.stdout).toBe("1");
  });

  it("別の Issue の PR は、結び付けない", () => {
    // **枝の名前で結ぶ**（`bin/loop-claim idle` と同じ口）——**`Closes` を書かない PR が
    // ある**（#321）ので、**そちらでは結べない。**
    const listed = run([501], lines([{ number: 502, branch: "fix/999-other", labels: WAITING }]));

    expect(listed.stdout, "別の Issue の PR で数を引いている").toBe("1");
  });

  it("番号の前方一致で結ばない", () => {
    // **`fix/5011-...` は #501 の PR ではない**
    const listed = run([501], lines([{ number: 502, branch: "fix/5011-x", labels: WAITING }]));

    expect(listed.stdout, "前方一致で結んでいる").toBe("1");
  });

  it("複数の Issue を、それぞれ数える", () => {
    const listed = run(
      [501, 601],
      lines([
        { number: 502, branch: "fix/501-count", labels: WAITING },
        { number: 602, branch: "feat/601-x" },
      ]),
    );

    expect(listed.stdout).toBe("1");
  });

  it("割った親にも、子 Issue の PR で結ぶ", () => {
    // **子 Issue を立てて割ると、枝が名乗るのは子の番号**（#544）——**親の番号を持つ
    // 枝が 1 本も出ない。** **そのままだと「PR がまだ無い＝実装中」として数え、
    // この口が消しに来た状態が残る。** **実データの形**（親 #540 / 子 #542）。
    const listed = run([540], lines([{ number: 543, branch: "feat/542-title", labels: WAITING }]), {
      542: "図の箱に、PR のタイトルを出す（#540）",
    });

    expect(listed.stdout, "割った親に結べていない").toBe("0");
  });

  it("孫の PR でも、親に結ぶ", () => {
    // **割った先を、さらに割ってよい**（起票の規則）——**判定は
    // `bin/loop-issue-descendants` が持っている**ので、**そこがそのまま効く**
    const listed = run([540], lines([{ number: 547, branch: "feat/546-x", labels: WAITING }]), {
      542: "そのうちの 1 つ（#540）",
      546: "さらに小さく（#542）",
    });

    expect(listed.stdout, "孫の PR で親に結べていない").toBe("0");
  });

  it("親子を並べられなければ、0 件へ倒さない", () => {
    // **読めないものを「子が無い」に倒すと、進められない Issue を数え続ける**
    const dir = mkdtempSync(join(tmpdir(), "in-progress-work-fail-"));
    sandboxes.push(dir);
    writeFileSync(join(dir, "gh"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
    chmodSync(join(dir, "gh"), 0o755);

    const done = spawnSync(SCRIPT, ["540"], {
      input: "",
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
    });

    expect(done.status, "読めないまま数えている").toBe(2);
  });

  it("空白を含む label があっても、列がずれない", () => {
    // **GitHub の label 名には空白を入れられる**——**空白で繋ぎ直すと、そこで列が割れる**
    const listed = run(
      [501],
      lines([{ number: 502, branch: "fix/501-count", labels: ["needs human", ...WAITING] }]),
    );

    expect(listed.stdout, "空白を含む label で列がずれている").toBe("0");
  });

  it("着手中が無ければ、0 を返す", () => {
    // **使い方の誤りではない**——**`in-progress` が 0 件の周回は普通にある**
    const listed = run([], "");

    expect(listed.status).toBe(0);
    expect(listed.stdout).toBe("0");
  });

  it("読めない行を、0 件へ倒さない", () => {
    // **飲み込むと「作業が尽きた」に化ける**——**人待ちでもないのに人が呼ばれる**
    const listed = run([501], "これは PR の一覧ではない");

    expect(listed.status).toBe(2);
    expect(listed.stderr).not.toBe("");
  });

  it("Issue 番号が読めなければ落ちる", () => {
    expect(spawnSync(SCRIPT, ["abc"], { input: "", encoding: "utf8" }).status).toBe(2);
  });

  it("使い方の案内が、いまの書式を言う", () => {
    // **契約が 2 箇所にある**（冒頭のコメントと `usage()`）——**書式を変えたとき、
    // 案内だけ前のまま残る**（#551 のレビュー）
    const usage = spawnSync(SCRIPT, ["abc"], { input: "", encoding: "utf8" }).stderr;

    expect(usage, "枝を案内していない").toContain("<枝>");
    expect(usage, "label の並べ方を案内していない").toContain("<label><US><label>");
  });
});
