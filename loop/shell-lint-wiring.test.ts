/**
 * **`bin/` の bash を、どこで見るか**（#377）。
 *
 * **決めたのは「CI で見る」**である。**`./task check` には入れていない**——
 * **`./task check` の中身はコンテナで走り**（`AGENTS.md` §2）、**そこに shellcheck は
 * 入っていない。** **入れるならイメージを作り直すことになり、走っている作業場は
 * 次の周回で赤くなる**（`./task build` を打つまで）——**この Issue は lint を足す話で、
 * 他の作業場を止める話ではない。**
 *
 * **ホストの shellcheck には頼らない。** **ホストに何が入っているかは、この道具が
 * 決めることではない**（§2 の向き）——**いま入っているのは偶然**である。
 *
 * **踏んでから気づくまでは 1 往復**である（**#376 で実際にその 1 往復で気づけた**）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

describe("bash の lint", () => {
  it("CI が打つ", () => {
    expect(read(".github/workflows/audit.yml")).toContain("bin/lint-shell");
  });

  it("CI に一覧を書き写さない", () => {
    // **2 箇所に持つと、片方だけ古くなる**（§5）——**対象は bin/lint-shell が持つ**
    const workflow = read(".github/workflows/audit.yml");

    expect(workflow, "一覧が CI にも書いてある").not.toMatch(/shellcheck .*task docker-entrypoint/);
  });

  it("CI が止める側である", () => {
    // **`|| true` を付けると、指摘が出ても緑になる**——**見ているだけになる**
    const shellJob = read(".github/workflows/audit.yml").split("shell:")[1] ?? "";

    expect(shellJob, "落ちない形で打っている").not.toMatch(/bin\/lint-shell.*\|\|/);
  });
});
