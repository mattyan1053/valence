import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

describe("./task check の読み方", () => {
  it("worker の手順書が、合否を終了コードで決めると書いている", () => {
    // **テストが緑であることと、`./task check` が通ることは別**である。
    // 出力を絞って読むと、絞り込みに入っていない失敗が**表示から消える**——
    // #76 は型検査、#117 は Biome の複雑度で、**消えた失敗の種類が毎回違う**。
    // **絞り込みのパターンを足す方向では塞がらない。**
    const doc = read(".claude/commands/loop-worker.md");

    expect(doc).toMatch(/終了コード/);
    expect(doc).toMatch(/出力[^\n]*(絞|文言)/);
  });

  it("master の手順書にも、同じ読み方が書いてある", () => {
    // master は `./task check` を実行しないが、**`bin/loop-*` の終了コードで
    // 分岐する箇所は同じ性質**を持つ。**既にあるなら足さない**——
    // ここは「足りていること」を固定するだけである
    expect(read(".claude/commands/loop-master.md")).toMatch(
      /終了コードで分岐する。出力の文言で判断しない/,
    );
  });
});
