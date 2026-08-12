import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/**
 * 手順書が実際に打つ停止識別子。
 *
 * **引用符の有無で取りこぼさない。** 手順書は `bin/loop-stall "…"` とも
 * `bin/loop-stall pr-lookup-failed` とも書く——**片方だけ見ると、
 * 打っているのに「誰も打たない」に見える**
 */
const STALL_CALL = /bin\/loop-stall (?:"([^"]+)"|([a-z][\w:<>-]*))/g;

function identifiersIn(path: string): string[] {
  return [...read(path).matchAll(STALL_CALL)].map((match) => match[1] ?? match[2] ?? "");
}

/** 節ごとに、そこで打つ識別子を並べる。**絞らずに全部出す**（列挙が主題である）。 */
function identifiersWithSection(path: string): [string, string][] {
  const pairs: [string, string][] = [];
  let section = "";
  for (const line of read(path).split("\n")) {
    if (/^#{2,4} /.test(line)) {
      section = line.trim();
    }
    const found = new RegExp(STALL_CALL.source).exec(line);
    const id = found?.[1] ?? found?.[2];
    if (id !== undefined) {
      pairs.push([section, id]);
    }
  }
  return pairs;
}

/** `bin/loop-stall --list` が持つ書式（一覧の正）。 */
function listedSpecs(): string[] {
  return execFileSync(join(REPO_ROOT, "bin/loop-stall"), ["--list"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.trim().split(/\s+/)[0] ?? "");
}

/**
 * **1 つの状態に、1 つの名前。**
 *
 * 第 4 層は**文字列一致**で数えるので、**識別子が揺れた時点で沈黙する**——
 * **呼ぶべきときに呼ばない**（#128）。実測では、**同じ膠着に 2 周続けて別の名前**が
 * 当たった。**変わったのは状態ではなく、master が label を付けたこと**である。
 */
describe("停止識別子", () => {
  it("master の操作で名前が変わる組み合わせが残っていない", () => {
    // **`changes-requested` は「待っている状態の性質」ではなく、
    // 「master がその周回までに何をしたか」**である。**同じ「worker の対応待ち」に
    // 2 つの名前があると、label を付けた瞬間に別状態として数え直される**。
    //
    // **選び方を自動化しても、選ぶ対象が 2 つあることは変わらない**——
    // **名前を 1 つにすれば、そもそも割れない**
    const specs = listedSpecs().map((spec) => spec.split(":")[0]);

    expect(specs, "worker の対応待ちに 2 つの名前がある").not.toContain("changes-requested");
    expect(specs, "worker の対応待ちに 2 つの名前がある").not.toContain("blocking-findings");
    expect(specs, "worker の対応待ちを表す名前が無い").toContain("awaiting-worker");
  });

  it("手順書は、一覧にある識別子だけを打つ", () => {
    // **綴りが 1 文字違うだけで、別状態として数え直される**（3 周続いても止まらない）
    const specs = new Set(listedSpecs());
    const used = [
      ...identifiersIn(".claude/commands/loop-master.md"),
      ...identifiersIn(".claude/commands/loop-worker.md"),
    ];

    expect(used.filter((id) => !specs.has(id))).toEqual([]);
  });

  it("どの節で何を打つかを、列挙して突き合わせる", () => {
    // **絞ってから見ない。** 前の版は `awaiting-worker` で始まるものだけを集めてから
    // 「1 つか」を見ていたので、**別の名前へ変えたものは集合から抜けるだけ**で、
    // **残ったぶんで両方の条件が満たされた**——**割れたことを、割れた側を見ずに
    // 判定していた**。**この PR が塞ごうとしている壊れ方そのもの**である。
    //
    // **列挙すれば、書く人がここで必ず立ち止まる。** 主体（worker / 人 / Codex）が
    // 違うものを同じ名前で打っていないかも、並べれば目に入る——
    // **`awaiting-worker` は `WORKER_FIXES` に入る**ので、**worker が解けない状態に
    // 打つと、worker の周回が動いている間ずっと数えられない**。
    expect(identifiersWithSection(".claude/commands/loop-master.md")).toEqual([
      ["### 1.0 同じ役の周回が走っていないか確かめる", "wrong-worktree"],
      ["### 1.1 手順とスクリプトを最新にする", "main-sync-failed"],
      ["## 2. open PR を見て、見る順番を決める", "pr-lookup-failed"],
      ["### exit 0 — マージする", "merge-failed:<PR番号>@<SHA>"],
      ["### exit 0 — マージする", "merge-failed:<PR番号>@<SHA>"],
      ["### exit 1 — 何が足りないかで分ける", "deferred-overflow"],
      ["### 要求が満たされたか確かめる（`changes-requested`）", "awaiting-worker:<PR番号>@<SHA>"],
      ["### 3.2 レビューを要求してよいか確かめる", "review-budget-unknown:<PR番号>"],
      // **評価した head が動いたら、その周回の判断は記録も投稿もしない**（#145）。
      // **worker の対応待ちではない**ので `awaiting-worker` とは別に数える——
      // 待っているのは worker ではなく、**次の周回で自分が評価し直す**ことである
      ["### 3.2 レビューを要求してよいか確かめる", "head-unconfirmed:<PR番号>"],
      ["### 3.2 レビューを要求してよいか確かめる", "review-budget-unknown:<PR番号>"],
      ["### 3.2 レビューを要求してよいか確かめる", "review-budget-unknown:<PR番号>"],
      ["### 3.2 レビューを要求してよいか確かめる", "review-unanswered:<PR番号>@<SHA>"],
      ["### 3.2 レビューを要求してよいか確かめる", "review-budget-unknown:<PR番号>"],
      ["### exit 2 — 設定か使い方の誤り", "gate-misconfigured:<PR番号>"],
      // **読んだ指摘は、評価した head に対するもの**である（#145）。
      // **動いていたら投稿しない**——次の周回で読み直す
      ["### まだ誰も答えていない指摘", "head-unconfirmed:<PR番号>"],
      ["#### rework — worker へ差し戻す", "head-unconfirmed:<PR番号>"],
      ["#### rework — worker へ差し戻す", "awaiting-worker:<PR番号>@<SHA>"],
      // **人を呼ぶ側は worker 待ちではない。** triage が `human` を返した状態で、
      // **worker には解けない**——`bin/loop-stall` 自身が「**主体が違うものに
      ["#### human — 人を呼ぶ", "review-exhausted:<PR番号>@<SHA>"],
      // **人を呼ぶ側は worker 待ちではない。** triage が `human` を返した状態で、
      // **worker には解けない**——`bin/loop-stall` 自身が「**主体が違うものに
      ["#### human — 人を呼ぶ", "review-exhausted:<PR番号>@<SHA>"],
      ["#### defer — Issue へ外出ししてマージする", "deferred-overflow"],
      ["## 6. 着手順を決める（`ready` を 1 件に保つ）", "issue-lookup-failed"],
      ["## 6. 着手順を決める（`ready` を 1 件に保つ）", "too-many-ready:<件数>"],
      ["### 作業が尽きたとき", "no-work"],
      ["### 周回の出口", "claim-mismatch:<Issue番号>"],
      ["### 周回の出口", "handoff-mismatch:<PR番号>"],
    ]);
  });

  it("一覧にあるのに、誰も打たない識別子が無い", () => {
    // **打つ場所が消えても、一覧だけが残る**（#162 で `review-exhausted` の分岐が
    // 括弧書きへ落ち、**いつ使うのかが消えた**）。**一覧は「使える識別子」の正**なので、
    // **誰も打たないものが混ざると、読む人は「まだ使うのだろう」と思う**
    const used = new Set([
      ...identifiersIn(".claude/commands/loop-master.md"),
      ...identifiersIn(".claude/commands/loop-worker.md"),
    ]);
    const unused = listedSpecs().filter(
      (spec) => !used.has(spec) && !identifiersIn(".claude/commands/loop-worker.md").includes(spec),
    );

    expect(unused, "打つ場所が無い識別子が一覧に残っている").toEqual([]);
  });
});
