import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { procedureText } from "./procedure-doc";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 着手を決めている節。**文書全体で見ない**——別の節の同じ言い回しで満たされる。 */
function claimSection(): string {
  const section = procedureText("worker").split("## 4. `ready` から 1 件を取って実装する")[1];
  if (section === undefined) {
    throw new Error("worker の手順書に着手の節がありません");
  }
  return section.split("\n## ")[0] ?? "";
}

/** 着手中の Issue を再開する節。**ここが claim を通らない入口だった。** */
function resumeSection(): string {
  const section = procedureText("worker").split("### 2.2 公開に失敗した周回を再開する")[1];
  if (section === undefined) {
    throw new Error("worker の手順書に再開の節がありません");
  }
  return section.split("\n## ")[0] ?? "";
}

/** その節の bash ブロックだけ。**散文の言及では「実行している」ことにならない。** */
function bashBlocks(section: string): string {
  return section
    .split("```bash")
    .slice(1)
    .map((chunk) => chunk.split("```")[0] ?? "")
    .join("\n");
}

describe("着手の取り合い", () => {
  it("手順書は取り合いをスクリプトに任せる", () => {
    expect(bashBlocks(claimSection())).toContain("bin/loop-claim take");
  });

  it("再開する側も、持ち主を確かめてから進む", () => {
    // **入口は 2 つある。** ステップ 2.2 は label しか見ておらず、**claim を通らずに
    // 実装へ入れた**（#100 のレビュー指摘）。取った側がブランチを作る前の窓が、
    // そのまま重複 PR になる
    expect(bashBlocks(resumeSection())).toContain("bin/loop-claim resume");
  });

  it("別の作業場が実装中なら触らないと書いてある", () => {
    // **「自分の中断した作業」と「他人が実装中」を区別する。** label には持ち主が無い
    expect(resumeSection()).toMatch(/別の作業場/);
    expect(resumeSection()).toMatch(/触らない|飛ばす|次へ/);
  });

  it("素の label 付け替えが残っていない", () => {
    // **これが本体。** 手順書に生の付け替えが残っていると、そちらを実行した周回だけが
    // 取り合いを起こす。**2 通りのやり方を並べない**
    expect(bashBlocks(claimSection())).not.toMatch(/gh issue edit[^\n]*--add-label in-progress/);
  });

  it("取れなかったときに待たないと書いてある", () => {
    // **待つと、そこが新しい詰まりどころになる**（#74 の lease と同じ判断）
    expect(claimSection()).toMatch(/待たない/);
  });

  it("exit の意味を、スクリプトの使い方と揃えている", () => {
    // **2 箇所に書くと片方だけ直して食い違う。** 使い方に出る語で手順書を書く
    const usage = execFileSync(
      "bash",
      ["-c", `"${join(REPO_ROOT, "bin/loop-claim")}" 2>&1 || true`],
      {
        // **砂場で引く** (#398 のレビュー)。**使い方は cwd に依らない**が、
        // **`bin/loop-lease check` は cwd の git へ書く。**
        cwd: mkdtempSync(join(tmpdir(), "claim-usage-")),
        encoding: "utf8",
      },
    );
    const section = claimSection();

    expect(usage).toMatch(/exit 1[^\n]*次の Issue/);
    expect(section).toMatch(/exit 1[\s\S]{0,200}次の Issue/);
    expect(section).toMatch(/exit 2/);
  });
});

describe("label と実態の食い違い", () => {
  it("master は毎周回、食い違いを見にいく", () => {
    // **呼ぶ場所を散文で並べない。** 経路が増えたときに漏れる（#92 と同じ形）
    const exitSection = procedureText("master").split("### 周回の出口")[1] ?? "";

    expect(exitSection).toContain("bin/loop-claim audit");
  });

  it("止める側の行き先が書いてある", () => {
    const exitSection = procedureText("master").split("### 周回の出口")[1] ?? "";

    expect(exitSection).toContain("claim-mismatch");
    expect(
      execFileSync(join(REPO_ROOT, "bin/loop-stall"), ["--list"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      }),
    ).toContain("claim-mismatch");
  });
});
