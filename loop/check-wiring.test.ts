import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
    // **語の有無で見ない。** `終了コード` と `出力` が文書のどこかに別々にあれば通る
    // 形だと、**肝心の指示を消して説明文に置き換えても緑のまま**になる——
    // **この PR が防ごうとしている「消えても気づけない」が、検査の側に残る**。
    // master 側と同じく**文そのもの**を見る（#121 のレビュー指摘）。
    //
    // **言い換えるたびに落ちて邪魔になる、という反対もある。それでもこちらへ倒す。**
    // 落ちたときは**人が見て直せば済む**が、**緩いほうは消えても誰も気づかない**。
    expect(read(".claude/commands/loop-worker.md")).toMatch(
      /`\.\/task check` の合否は終了コードで決める/,
    );
  });

  it("書いてあるとおりに打つと、失敗が失敗として残る", () => {
    // **指示があることと、指示どおりで正しくなることは別**である（#121 のレビュー指摘）。
    // `./task check | grep ...` の `$?` は **grep のもの**で、**check の合否は消える**——
    // **「絞ってよい」と「終了コードで決める」を素直に守ると、そこへ落ちる**。
    //
    // **手順書の書き方をそのまま実行して確かめる。** 文言を見るだけだと、
    // **従っても間違える指示**を素通しにする。
    const block = read(".claude/commands/loop-worker.md")
      .split("```bash")
      .map((chunk) => chunk.split("```")[0] ?? "")
      .find((chunk) => chunk.includes("./task check") && chunk.includes("$?"));
    if (block === undefined) {
      throw new Error("終了コードを控える書き方が手順書にありません");
    }

    // **落ちるものに差し替えて打つ。** 控えた値が 2 のままなら、合否は消えていない
    const workspace = mkdtempSync(join(tmpdir(), "check-wiring-"));
    try {
      const printed = execFileSync(
        "bash",
        ["-c", `${block.replaceAll("./task check", "bash -c 'exit 2'")}\necho "status=$status"`],
        { cwd: workspace, encoding: "utf8" },
      );

      expect(printed).toContain("status=2");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
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
