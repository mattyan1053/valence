import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { procedureText } from "./procedure-doc";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 対象の一覧の正は **スクリプト**。手順書に書き写さない。 */
function watched(): string[] {
  return execFileSync(
    join(REPO_ROOT, "bin/loop-procedure-changed"),
    ["--role", "master", "--list"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
    },
  )
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
  const doc = procedureText("master");
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
    expect(procedureText("master")).toContain("bin/loop-procedure-changed");
  });

  it("手順書に対象の一覧を書き写さない", () => {
    // **2 箇所に持つと、ファイルが増えたときに片方だけ直して食い違う**
    const doc = procedureText("master");
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
    const section = procedureText("master")
      .split("### 1.1 手順とスクリプトを最新にする")[1]
      ?.split("\n## ")[0];

    expect(section).toMatch(/1 以外/);
    expect(section).toMatch(/126 \/ 127/);
  });

  it("マージした周回も、変わっていなければ続ける", () => {
    // **ここで終えると、次の周回まで誰も動かない。** マージでは通知を送らないので、
    // worker は自分の cron が来るまで何も知らない
    const doc = procedureText("master");
    const afterMerge = doc.split("### exit 0 — マージする")[1]?.split("\n### ")[0] ?? "";

    expect(afterMerge).toContain("bin/loop-procedure-changed");
    expect(afterMerge).toMatch(/ステップ 6/);
    // **比較の右辺がマージ後の状態になっていること。** 手元の HEAD は
    // マージでは動かないので、取り直さずに比べると必ず「変わっていない」になる
    //
    // **取り直しは冒頭と同じ口を通す** (#226 のレビュー)。**生の fetch だと、
    // 落ちても次の行が走り、古い `FETCH_HEAD` と比べて「変わっていない」と答える**
    // ——**それは正常な答えの顔をしている**ので、**赤くならないまま古い手順で進む。**
    expect(afterMerge).toMatch(/bin\/loop-sync-main/);
    expect(afterMerge, "取り直しが落ちても次の行が走る").toMatch(
      /if ! after="\$\(bin\/loop-sync-main\)"; then\n\s*bin\/loop-stall main-sync-failed/,
    );
    expect(afterMerge, "古い FETCH_HEAD と比べている").not.toMatch(
      /bin\/loop-procedure-changed [^\n]*FETCH_HEAD/,
    );
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
    const section = procedureText("master").split(heading)[1];
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
    // **「担保がある」とも書かない。** 1.1 は git の commit を比べるだけで、
    // **切り替えたあとは「変わっていない」と答える**ので、
    // **読んでいる版が古いことは検出できない**（確かめられないものを担保と呼ばない）
    expect(section).not.toMatch(/担保/);
  });
});

/**
 * **worker 側にも、版ずれで打ち切る経路がある** (#227)。
 *
 * **同期そのものが手順書に書かれている**ので、**同期する前は 1 つ前の版の手順書を
 * 読んでいる**——**同期したあとは「古い手順書 + 新しいスクリプト」で走る。**
 *
 * **master 側にだけ仕組みがあると、気づいた側が忘れた時点でそのまま残る。**
 */
describe("worker の版ずれ", () => {
  const doc = readFileSync(
    fileURLToPath(new URL("../.claude/commands/loop-worker.md", import.meta.url)),
    "utf8",
  );
  const sync = doc.split("### 1.0")[1]?.split("\n## ")[0] ?? "";

  it("同期のあとに、入れ替わったかを確かめる", () => {
    expect(sync).toMatch(/bin\/loop-procedure-changed --role worker/);
    // **比べる相手は、同期の前後**である。**片方でも取り違えると必ず
    // 「変わっていない」になり、古い手順のまま進む**
    expect(sync).toMatch(/before="\$\(git rev-parse HEAD\)"/);
    expect(sync).toMatch(/bin\/loop-procedure-changed --role worker "\$before" "\$after"/);
  });

  it("捨てる側へ倒す条件が書いてある", () => {
    // **`exit 1` だけが「続けてよい」**（1 以外はすべて捨てる。master と同じ扱い）
    expect(sync).toMatch(/1 以外/);
  });

  it("捨てるときは、消してから返して呼び直す", () => {
    // **ここはステップ 5 を通らずに周回を終える唯一の経路**で、**すぐ上で
    // `main-sync-failed` を積む**——**消し忘れると、成功した周回を挟んでいるのに
    // 3 周連続と数えて全ループを止める。**
    //
    // **握ったまま呼び直すと、呼び直された周回が 1.0 で自分自身に阻まれる。**
    // **1.0 でも lease を返す**ので、**捨てる段のところから先だけを見る**
    const reset = sync.indexOf("bin/loop-stall --reset");
    expect(reset, "カウンタを消していない").toBeGreaterThanOrEqual(0);
    const tail = sync.slice(reset);
    const release = tail.indexOf("bin/loop-lease release worker");
    const reinvoke = tail.indexOf("/loop-worker を呼び直す");

    expect(release, "lease を返していない").toBeGreaterThan(0);
    expect(reinvoke, "返す前に呼び直している").toBeGreaterThan(release);
  });

  it("呼び直しても届く保証は無い、と書いてある", () => {
    // **断定しない** (#228 のレビュー)。**実測で 2 回中 1 回は「instructions unchanged」で
    // 古い版のまま走った**（#94）——**呼び直した回は `before == after` になるので、
    // 届かなかったことは検出できない。** **それでも呼び直す**（届けば早い）。
    expect(sync, "保証が無いことを書いていない").toMatch(/保証は無い/);
    expect(sync, "検出できないことを書いていない").toMatch(/検出する手立ては無い/);
    expect(sync, "それでも呼び直す理由が無い").toMatch(/cron や人の起動/);
  });

  it("呼び直しは 1 回だけだと書いてある", () => {
    // **入れ替わりは追随した時点で収束する**ので、**2 回続けて起きるのは異常**である
    expect(sync).toMatch(/呼び直しは 1 回だけ/);
  });

  it("捨てすぎない理由も書いてある", () => {
    // **倒す先は 2 つある。** **毎周回 1 歩目で終わる形になっていないこと**が、
    // 読む人に分かる必要がある
    expect(sync).toMatch(/呼び直/);
  });

  it("版ずれだと読める形になっている", () => {
    // **`No such file or directory` は症状であって、版ずれとは読めない**
    expect(sync).toMatch(/No such file or directory/);
  });
});
