import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/** 対象の一覧の正は **スクリプト**。手順書に書き写さない。 */
function watched(): string[] {
  return execFileSync(join(REPO_ROOT, "bin/loop-procedure-changed"), ["--list"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => line !== "");
}

/**
 * master の手順書が**実行している**もの。
 *
 * **読むだけのものは数えない。** `loop/STOP` は状態であって手順ではなく、
 * 入れ替わっても master の実行内容は変わらない（毎周回そこを見るだけである）。
 */
function executedByMaster(): string[] {
  const doc = read(".claude/commands/loop-master.md");
  const found = [...doc.matchAll(/(?:^|[\s`(])((?:bin|src|scripts)\/[\w./-]+|\.\/task)/gm)]
    .map((match) => match[1] ?? "")
    .map((path) => (path === "./task" ? "task" : path));
  return [...new Set(found)];
}

describe("周回を捨てるかの判定", () => {
  /** 呼び直しの手前で何をするかが書かれた bash ブロック。 */
  function codeBlockWithRerun(section: string): string {
    const block = section
      .split("```bash")
      .slice(1)
      .map((chunk) => chunk.split("```")[0] ?? "")
      .find((chunk) => chunk.includes("/loop-master"));
    if (block === undefined) {
      throw new Error("呼び直しの手順が bash ブロックに書かれていません");
    }
    return block;
  }

  it("手順書は判定をスクリプトに任せる", () => {
    expect(read(".claude/commands/loop-master.md")).toContain("bin/loop-procedure-changed");
  });

  it("手順書に対象の一覧を書き写さない", () => {
    // **2 箇所に持つと、ファイルが増えたときに片方だけ直して食い違う**
    const doc = read(".claude/commands/loop-master.md");
    const listed = watched().filter((path) => path.endsWith("/") && doc.includes(`\`${path}\``));

    expect(listed).toEqual([]);
  });

  it("master が実行するものが、すべて対象に入っている", () => {
    // **一覧が実体からずれたら気づける。** master が新しい場所のものを実行し始めても、
    // 対象に入っていなければ**入れ替わったのに走り続ける**
    const uncovered = executedByMaster().filter(
      (path) => !watched().some((target) => path === target || path.startsWith(target)),
    );

    expect(uncovered).toEqual([]);
  });

  it("判定の分岐は「1 以外はすべて捨てる」になっている", () => {
    // **`exit 2` だけを並べると、並べ忘れた値が抜ける。** 判定器が消えた・
    // 実行できない（126 / 127）ときはどの分岐にも入らず、
    // **「判定不能なら捨てる」が成立しない**（実際に踏んだ）。
    //
    // **節を切って見る。** 文書全体を見ると、別の節の同じ言い回しが拾われて
    // **分岐を書き換えても通る**（実際に 0 件だった）
    const section = read(".claude/commands/loop-master.md")
      .split("### 1.1 手順とスクリプトを最新にする")[1]
      ?.split("\n## ")[0];

    expect(section).toMatch(/1 以外/);
    expect(section).toMatch(/126 \/ 127/);
  });

  it("マージした周回も、変わっていなければ続ける", () => {
    // **ここで終えると、次の周回まで誰も動かない。** マージでは通知を送らないので、
    // worker は自分の cron が来るまで何も知らない
    const doc = read(".claude/commands/loop-master.md");
    const afterMerge = doc.split("### exit 0 — マージする")[1]?.split("\n### ")[0] ?? "";

    expect(afterMerge).toContain("bin/loop-procedure-changed");
    expect(afterMerge).toMatch(/ステップ 6/);
    // **比較の右辺がマージ後の状態になっていること。** 手元の HEAD は
    // マージでは動かないので、取り直さずに比べると必ず「変わっていない」になる
    expect(afterMerge).toContain("git fetch origin main");
    expect(afterMerge).toMatch(/bin\/loop-procedure-changed [^\n]+ FETCH_HEAD/);
    // **呼び直す前に切り替える。** `fetch` は `FETCH_HEAD` を更新するだけで
    // **作業ツリーはマージ前のまま**なので、呼び直した先が**古い手順書を読む**
    // （1.1 の経路はそこで `switch --detach` しているので問題ない）
    const rerun = codeBlockWithRerun(afterMerge);

    expect(rerun.indexOf("git switch --detach origin/main")).toBeGreaterThanOrEqual(0);
    expect(rerun.indexOf("git switch --detach origin/main")).toBeLessThan(
      rerun.indexOf("/loop-master"),
    );
  });

  /** 打ち切りが書かれている 2 か所。**片方だけ直すと、そちらだけ空く。** */
  const DISCARD_POINTS = [
    { name: "1.1", heading: "### 1.1 手順とスクリプトを最新にする" },
    { name: "マージの段", heading: "### exit 0 — マージする" },
  ] as const;

  function sectionOf(heading: string): string {
    const section = read(".claude/commands/loop-master.md").split(heading)[1];
    if (section === undefined) {
      throw new Error(`loop-master.md に「${heading}」がありません`);
    }
    return section.split("\n### ")[0]?.split("\n## ")[0] ?? "";
  }

  it.each(DISCARD_POINTS)("$name で打ち切ったら、その場で呼び直す", ({ heading }) => {
    // **打ち切り自体は正しい。** 直すのは「そのあと」で、
    // **新しい手順書を読み直す機会が次の cron しか無い**ことが問題である
    const section = sectionOf(heading);

    expect(section).toContain("/loop-master");

    // **順序は「呼び直す手前で何をするか」で見る。** 散文の言及を拾うと、
    // **本文で名前に触れただけで順序が満たされたことになる**（実際にそうなった）
    const block = codeBlockWithRerun(section);

    // **カウンタを消してから呼び直す。** 順序を変えない
    expect(block.indexOf("bin/loop-stall --reset")).toBeGreaterThanOrEqual(0);
    expect(block.indexOf("bin/loop-stall --reset")).toBeLessThan(block.indexOf("/loop-master"));
    // **lease も返してから呼び直す。** 握ったまま呼び直すと、呼び直された周回が
    // **1.0 で自分自身に阻まれて何もせず終わる**（結局、次の cron まで動かない）
    expect(block.indexOf("bin/loop-lease release master")).toBeGreaterThanOrEqual(0);
    expect(block.indexOf("bin/loop-lease release master")).toBeLessThan(
      block.indexOf("/loop-master"),
    );
  });

  it.each(DISCARD_POINTS)("$name の呼び直しは 1 回だけと書いてある", ({ heading }) => {
    // **入れ替わりは追随した時点で収束する**ので、2 回続くのは異常である。
    // 繰り返す形にすると、壊れたときに止まらなくなる
    expect(sectionOf(heading)).toMatch(/1 回だけ/);
  });

  it.each(DISCARD_POINTS)("$name は、読み直されることを保証しない", ({ heading }) => {
    // **呼び直しても、同じセッションで既に読み込まれていると古い版のまま走る**
    // （実測で 2 回中 1 回。「instructions unchanged」と返る）。
    // **保証できないことを手順書に書かない**——このリポジトリが繰り返し塞いできた
    // 「意図と実装の食い違い」が、手順書そのものに入る
    const section = sectionOf(heading);

    expect(section).not.toMatch(/ディスクから\s*\n?読み直される/);
    expect(section).toMatch(/保証(は)?(無|な)い/);
  });
});
