import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { procedureText } from "./procedure-doc";

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
    expect(procedureText("worker")).toMatch(/`\.\/task check` の合否は終了コードで決める/);
  });

  it("書いてあるとおりに打つと、失敗が失敗として残る", () => {
    // **指示があることと、指示どおりで正しくなることは別**である（#121 のレビュー指摘）。
    // `./task check | grep ...` の `$?` は **grep のもの**で、**check の合否は消える**——
    // **「絞ってよい」と「終了コードで決める」を素直に守ると、そこへ落ちる**。
    //
    // **手順書の書き方をそのまま実行して確かめる。** 文言を見るだけだと、
    // **従っても間違える指示**を素通しにする。
    //
    // **1 つ目だけを取らない**（#147）。**`find` で 1 つ取ると名指しと同じ**になり、
    // **打つところが増えても気づけない**——**実際に 4 箇所ある**（rebase・対応後・
    // 実装中・PR を作る前）。**穴（`<…>`）は埋めて、全部走らせる。**
    const blocks = procedureText("worker")
      .split("```bash")
      .slice(1)
      .map((chunk) => chunk.split("```")[0] ?? "")
      .filter((chunk) => chunk.includes("./task check"));
    expect(blocks.length, "`./task check` を打つブロックが見つからない").toBeGreaterThan(0);

    const workspace = mkdtempSync(join(tmpdir(), "check-wiring-"));
    try {
      // **`gh` と `git` は呼ばせない。** 見たいのは**合否の残り方**であって、
      // その周りのコマンドではない
      const stub = join(workspace, "stub");
      mkdirSync(stub, { recursive: true });
      for (const command of ["gh", "git"]) {
        writeFileSync(join(stub, command), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
      }

      for (const block of blocks) {
        // **落ちるものに差し替えて打つ。** 印は合否に合わせて出す（殺された場合は別の試験）
        const body = block
          .replace(/<[^>]+>/g, "1")
          .replaceAll("./task check", "bash -c 'echo check-exit=2; exit 2'");
        const result = spawnSync("bash", ["-c", `${body}\necho "status=$status reached-end"`], {
          cwd: workspace,
          encoding: "utf8",
          env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
        });

        if (/git push/.test(block)) {
          // **push があるブロックは、赤なら先へ進まない**（#147 のレビュー 2 周目）。
          // **`| grep` で繋いで合否が消えると、ここが素通りする**
          expect(result.stdout, "赤なのに最後まで進んでいる").not.toContain("reached-end");
        } else {
          // **読むだけのブロックは、控えた値が残っていること**——**それが #121 の主題**である
          expect(result.stdout, "合否が消えている").toContain("status=2");
        }
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("master の手順書にも、同じ読み方が書いてある", () => {
    // master は `./task check` を実行しないが、**`bin/loop-*` の終了コードで
    // 分岐する箇所は同じ性質**を持つ。**既にあるなら足さない**——
    // ここは「足りていること」を固定するだけである
    expect(procedureText("master")).toMatch(/終了コードで分岐する。出力の文言で判断しない/);
  });
});
