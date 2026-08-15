import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/** 上限に達した PR の行き先を決めている節。**文書全体で見ない。** */
function triageSection(): string {
  const section = read(".claude/commands/loop-master.md").split(
    "### 上限に達した PR をどこへ渡すか",
  )[1];
  if (section === undefined) {
    throw new Error("master の手順書に打ち切りの節がありません");
  }
  return section.split("\n## ")[0] ?? "";
}

function bashBlocks(section: string): string {
  return section
    .split("```bash")
    .slice(1)
    .map((chunk) => chunk.split("```")[0] ?? "")
    .join("\n");
}

describe("上限に達したあとの行き先", () => {
  it("手順書は判定をスクリプトに任せる", () => {
    // **散文で「小さいから」と書けるようにすると、都度判断が戻ってくる**（#73）
    expect(bashBlocks(triageSection())).toContain("bin/loop-triage");
  });

  it("手順書に閾値を書き写さない", () => {
    // **2 箇所に持つと片方だけ直して食い違う。** 60 も 5 もスクリプトが持つ
    expect(triageSection()).not.toMatch(/60 行/);
    expect(triageSection()).not.toMatch(/5 件/);
  });

  it("古い「優先度 1 / 2 が残るなら人へ渡す」が残っていない", () => {
    // **食い違いを残さない。** これが #73 の主題である
    const doc = read(".claude/commands/loop-master.md");

    expect(doc).not.toMatch(/優先度 1（正しさ）・2（セキュリティ）が残る/);
  });

  it("外出しするときに、後から当否を再判断できるものを残すと書いてある", () => {
    // **指摘の原文が無いと、読み返しても当否を判断できない**（#73 の完了条件）
    const section = triageSection();

    expect(section).toContain("deferred-finding");
    expect(section).toMatch(/原文/);
    expect(section).toMatch(/SHA/);
  });

  it("歯止めはマージの手前（ゲート）にある", () => {
    // **外出しの経路だけに置いても効かない。** そこで止めても、次の周回は
    // 未解決スレッドが無くなっていてゲートが通り、**マージが 1 周遅れるだけ**になる
    // （#103 のレビューで指摘された）。**マージの手前は全部ゲートを通る**
    expect(read("bin/loop-gate")).toContain("loop-deferred-budget");

    const listed = execFileSync(join(REPO_ROOT, "bin/loop-stall"), ["--list"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    expect(listed).toContain("deferred-overflow");
  });

  it("ゲートが落ちたときの行き先が手順書にある", () => {
    // **記録しないと、溜まったまま何周でも回る**（他の停止と同じ理由）
    // **節を切って見る。** 切らないと、後ろの節にある同じ語で満たされる（実際に通った）
    const failTable = read(".claude/commands/loop-master.md")
      .split("### exit 1 — 何が足りないかで分ける")[1]
      ?.split("\n### ")[0];

    expect(failTable).toContain("deferred-overflow");
  });

  it("外出しは、作る前に空き枠を見る", () => {
    // **作ってから数えると、label 検索の索引が遅れて自分の 1 件が見えない**
    // （この環境で実測済み。#101）。ゲートの検査は他の経路のために残す——
    // **閾値はスクリプト 1 箇所のままで、呼ぶ場所が 2 つになるだけ**なので食い違わない
    const block = bashBlocks(triageSection());

    expect(block).toContain("bin/loop-deferred-budget --adding 1");
    expect(block.indexOf("bin/loop-deferred-budget")).toBeLessThan(
      block.indexOf("gh issue create"),
    );
  });

  it("差し戻す側でも記録が残ると書いてある", () => {
    // **対応が来ないまま何周も回らない**こと（#73 の完了条件）
    expect(triageSection()).toContain("bin/loop-stall");
  });

  it("README は、これが交換であって改善ではないと書いている", () => {
    // **後から読む人がこれを改善だと誤読しないように。**
    // 誰も `deferred-finding` を読まなければ、単に品質が下がっただけになる
    const doc = read("loop/README.md");

    expect(doc).toMatch(/交換であって改善ではない/);
    expect(doc).toMatch(/deferred-finding/);
  });

  it("README と手順書で、同じことを別々に書いていない", () => {
    // **判定の順を 2 箇所に書かない**（#73 の完了条件）
    expect(read("loop/README.md")).not.toMatch(/入れる前より悪くなる/);
  });
});

describe("指摘 0 件で、手直しが上限を超えている（#324）", () => {
  it("実測を渡している", () => {
    // **`--rework-lines`（見込み）だけでは、この状態を判定できない**——
    // **ゲートが実測した行数を渡さないと、スクリプトは exit 2 で止まる**
    expect(bashBlocks(triageSection())).toContain("--fixup-lines");
  });

  it("数え直しの行き先が書いてある", () => {
    // **スクリプトが返す行き先に、手順書側の受け皿が無いと、
    // 読む側は「知らない答え」を受けて止まる**
    expect(triageSection()).toContain("recount");
  });

  it("その行き先が、実際にゲートを通せる手を指している", () => {
    // **完了条件**（#324）。**「Issue を作る」だけでは通らない**——
    // **`main` を取り込み直すと head が変わり、レビューが数え直される**
    const section = triageSection();
    const from = section.indexOf("recount");
    expect(from, "recount の節が無い").toBeGreaterThanOrEqual(0);
    const recount = section.slice(from).split("\n#### ")[0] ?? "";

    expect(recount, "取り込み直す手が書いていない").toMatch(/取り込み直/);
    expect(recount, "数え直されることに触れていない").toMatch(/数え直/);
  });

  it("外出しの節が、この状態を引き取ると言っていない", () => {
    // **`defer` は「片付いた」と読めるのに、状態は 1 ミリも動かない**——
    // **外出しする指摘が無いときに、そこへ倒す書き方を残さない**
    const section = triageSection();
    const from = section.indexOf("#### defer");
    expect(from, "defer の節が無い").toBeGreaterThanOrEqual(0);
    const defer = section.slice(from).split("\n#### ")[0] ?? "";

    expect(defer, "指摘が無くても外出しすると読める").not.toMatch(/指摘が無くても|0 件でも/);
  });
});

describe("recount の受け皿が、rework と同じ穴を開けていない（#326 のレビュー）", () => {
  /** `recount` の節。**ここが待ちを作る**ので、節の外で満たさせない。 */
  function recountSection(): string {
    const section = triageSection();
    const from = section.indexOf("#### recount");
    expect(from, "recount の節が無い").toBeGreaterThanOrEqual(0);
    return section.slice(from).split("\n#### ")[0] ?? "";
  }

  it("投稿できた周回でも、対応待ちを記録する", () => {
    // **落ちた枝にだけ置いても足りない。** **本題は「投稿できて、worker が
    // まだ push していない」周回**である——**そこで記録しないと、同じ依頼を
    // 毎周回投稿し続け、3 周のエスカレーションへ到達しない**（`rework` と同じ穴）。
    // **識別子に head SHA が入る**ので、**push された周回は数え直される**
    // **依頼を投稿しているブロックを選ぶ。** **最初の 1 つを取ると head の確認に当たり、
    // **変異を入れても入れなくても落ちる**（試験が主張より弱くなる）
    const [block = ""] = recountSection()
      .split("```bash")
      .slice(1)
      .map((chunk) => chunk.split("```")[0] ?? "")
      .filter((chunk) => chunk.includes("gh pr comment"));
    const success = block.slice(block.lastIndexOf("\nelse"));

    expect(success, "投稿できた枝が見つからない").toContain("else");
    expect(success, "投稿できた周回で対応待ちを記録していない").toContain(
      'bin/loop-stall "awaiting-worker:<PR番号>@<SHA>"',
    );
  });

  it("投稿できたかを確かめる", () => {
    // **投稿が落ちても、待ちだけが残る**——**理由の無い待ちを作らない**
    expect(recountSection(), "投稿の成否を見ていない").toMatch(/if ! gh pr comment/);
  });

  it("ループの外の著者を、worker へ渡さない", () => {
    // **worker は `--author @me` で自分の PR だけを列挙する**ので、
    // **外の著者の PR は誰も rebase しない**——**待つと SHA が変わらないまま
    // 3 周で `loop/STOP`**（#70。`rework` は既に分けている）
    expect(recountSection(), "著者を確かめていない").toContain("bin/loop-outside-author");
    expect(recountSection(), "人待ちへ倒していない").toContain("awaiting-human");
  });

  it("main が進んでいなくても head が変わる手を指している", () => {
    // **`origin/main` が既に head の祖先なら、`git rebase origin/main` は
    // 「up to date」で何も書き換えない**——**レビューは live のままなので、
    // 次のゲートも同じ行数超過で `recount` に戻る**（行き止まりが続く）。
    // **レビューが live かは commit が祖先かで決まる**（`bin/loop-review-commits`）ので、
    // **commit を作り直す形を名指しする**
    expect(recountSection(), "取り込むものが無いときに head が変わらない").toMatch(
      /--force-rebase|作り直/,
    );
  });
});
