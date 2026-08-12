import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/** 手順書が実際に打つ停止識別子（`bin/loop-stall "…"` の引数）。 */
function identifiersIn(path: string): string[] {
  return [...read(path).matchAll(/bin\/loop-stall "([^"]+)"/g)].map((match) => match[1] ?? "");
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

  it("worker の対応待ちは、手順書のどこでも同じ名前で打つ", () => {
    // **同じ状態が 3 周続けば `loop/STOP` に到達する**ためには、
    // **3 周とも同じ名前で打たれる**ことが要る。**master の周回は経路が複数**あり、
    // **どの経路を通っても同じ状態なら同じ名前**でなければならない
    const master = read(".claude/commands/loop-master.md");
    const waiting = identifiersIn(".claude/commands/loop-master.md").filter((id) =>
      id.startsWith("awaiting-worker"),
    );

    expect(waiting.length, "worker の対応待ちを打つ場所が無い").toBeGreaterThan(1);
    expect(new Set(waiting).size, "同じ状態に違う書式が混ざっている").toBe(1);
    // **head SHA は残す。** 「変われば前へ進んだ」を表す値なので、変わってよい
    expect(waiting[0]).toContain("@<SHA>");
    // **判断を手順書に残さない。** 「どちらを使うか」を散文で決めると、書いてあっても踏み外す
    expect(master).not.toMatch(/どちらの識別子|識別子を選/);
  });
});
