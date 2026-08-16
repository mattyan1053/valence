/**
 * **どの一覧にも出てこない open Issue を見つける** (#325)。
 *
 * **#319 で実際に起きた。** **`in-progress` を外した先が無く**、**open のまま label が
 * 0 件**になった——**master のステップ 6 が読むのは `ready` / `in-progress` / `backlog`**
 * なので**昇格の候補にも上がらず**、**`audit` も `handoff` も黙った**（**どちらも
 * 「label と PR の食い違い」を見るもの**で、**label が無いことは食い違いではない**）。
 *
 * **全部の検査が「健全」と答える。** **気づいたのは master が前の周回を覚えていたから**で、
 * **セッションが落ちれば消える記憶**である。
 *
 * **モックを使わない**——**本物のスクリプトへ、本物と同じ形の入力を流す。**
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-unlisted-issues", import.meta.url));

type Issue = { number: number; labels: string[] };

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 偽の `gh` を置いて走らせる。
 *
 * **`--jq` の後ろの形で返す**（`bin/loop-claim idle` の偽物と同じ約束。
 * **本物の `gh` が絞ったあとの行**を、そのまま出す）。
 */
function run(options: { issues?: Issue[]; fails?: boolean; args?: string[] }): {
  status: number;
  stdout: string[];
  stderr: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "unlisted-issues-"));
  sandboxes.push(dir);
  const path = join(dir, "path");
  mkdirSync(path, { recursive: true });
  const lines = (options.issues ?? [])
    .map((issue) => `${issue.number}\t${issue.labels.join(",")}`)
    .join("\n");
  writeFileSync(
    join(path, "gh"),
    [
      "#!/usr/bin/env bash",
      ...(options.fails === true ? ["exit 1"] : []),
      `printf '%b' ${JSON.stringify(lines)}`,
      `[[ -n ${JSON.stringify(lines)} ]] && echo`,
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(path, "gh"), 0o755);

  const result = spawnSync(SCRIPT, options.args ?? [], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${path}:${process.env.PATH ?? ""}` },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout.split("\n").filter((line) => line !== ""),
    stderr: result.stderr,
  };
}

describe("bin/loop-unlisted-issues", () => {
  it("状態 label が 1 つも無い open Issue を挙げる", () => {
    // **これが本題である。** **外した先が無い Issue は、どのループの視界にも入らない**
    const listed = run({ issues: [{ number: 319, labels: [] }] });

    expect(listed.status, "どの一覧にも出てこない Issue を見逃している").toBe(1);
    expect(listed.stdout).toEqual(["319"]);
  });

  it.each(["backlog", "ready", "in-progress", "blocked"])(
    "`%s` が付いていれば挙げない",
    (label) => {
      // **緩めすぎない側ではなく、鳴らしすぎない側の担保。** **平常時に鳴る警告は
      // 読まれなくなる**（`bin/loop-stray-branches` と同じ）
      const listed = run({ issues: [{ number: 319, labels: [label] }] });

      expect(listed.status, `${label} が付いているのに挙げている`).toBe(0);
      expect(listed.stdout).toEqual([]);
    },
  );

  it("`waiting-condition` だけの Issue は挙げる", () => {
    // **あれは `backlog` に付ける修飾**である（`loop/README.md` の表）——
    // **`bin/loop-handoff` も `labels:["backlog","waiting-condition"]` と
    // 両方を指定して数える**ので、**単独で付いている Issue はどの一覧にも出てこない。**
    //
    // **倒す向きで決めた**——**鳴らしすぎても人が見て何も無いだけ**だが、
    // **鳴らし損ねると、この Issue が塞ぎに来た状態がそのまま残る。**
    const listed = run({ issues: [{ number: 319, labels: ["waiting-condition"] }] });

    expect(listed.status, "どの一覧にも出てこないのに黙っている").toBe(1);
    expect(listed.stdout).toEqual(["319"]);
  });

  it("`backlog` と併用された `waiting-condition` は挙げない", () => {
    // **本来の使い方。** **`backlog` に居るので、昇格の候補としては見えている**
    // （渡さないと決めているだけ）
    const listed = run({ issues: [{ number: 312, labels: ["backlog", "waiting-condition"] }] });

    expect(listed.status, "正しく付いている Issue で鳴っている").toBe(0);
    expect(listed.stdout).toEqual([]);
  });

  it("状態を表さない label だけでは、付いていないのと同じ", () => {
    // **`deferred-finding` や `awaiting-human` は状態ではない**——
    // **付いていても、どの一覧にも出てこない**
    const listed = run({ issues: [{ number: 300, labels: ["deferred-finding"] }] });

    expect(listed.status, "状態でない label で黙っている").toBe(1);
    expect(listed.stdout).toEqual(["300"]);
  });

  it("平常時は何も出さない", () => {
    // **毎周回出る警告は読まれなくなる**（`bin/loop-stray-branches` と同じ理由）
    const listed = run({
      issues: [
        { number: 1, labels: ["backlog"] },
        { number: 2, labels: ["in-progress", "waiting-condition"] },
      ],
    });

    expect(listed.status).toBe(0);
    expect(listed.stdout).toEqual([]);
  });

  it("複数あれば、全部挙げる", () => {
    const listed = run({
      issues: [
        { number: 319, labels: [] },
        { number: 320, labels: ["ready"] },
        { number: 325, labels: [] },
      ],
    });

    expect(listed.status).toBe(1);
    expect(listed.stdout).toEqual(["319", "325"]);
  });

  it("一覧を読めなければ、0 件と読まずに止まる", () => {
    // **測れないことを、健全と同じ出口にしない**（`bin/loop-claim idle` と同じ）
    // ——**「無い」と答えると、読めないあいだこの検出器だけが静かに消える**
    const listed = run({ issues: [{ number: 319, labels: [] }], fails: true });

    expect(listed.status, "読めなかったのに答えを返している").toBe(2);
    expect(listed.stderr).not.toBe("");
  });

  it("使い方の誤りは、無いと混ぜない", () => {
    expect(run({ args: ["余計な引数"] }).status).toBe(2);
  });
});
