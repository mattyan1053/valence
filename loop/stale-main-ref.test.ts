/**
 * **作業場の `main` は古いまま残る**（#697）。
 *
 * **どの作業場も `main` をブランチとして掴まない**（#196）ので、
 * **`bin/loop-sync-main` が動かすのは detached な `HEAD` だけ**である
 * ——**ローカルの `main` は、その作業場を作った日のまま止まる。**
 *
 * **実測（2026-09-11）**: **`main` = `2e6c913`（8/13）に対して
 * `origin/main` = `cfab381`**。**`git log -1 main -- .claude/commands/` は
 * `44f6617`（1 か月前）**、**`origin/main` で引くと `24826b0`（#645）**だった。
 *
 * **2 人が別のコマンドで踏んでいる**（`git log` と `git diff`）——**どちらも
 * 気づき方は偶然**（中身の食い違い／桁の違和感）である。**もっともらしい範囲に
 * 収まっていたら、そのまま使っていた。**
 */

import { describe, expect, it } from "vitest";
import { type LoopRole, procedureText } from "./procedure-doc";

const ROLES: readonly LoopRole[] = ["master", "worker"];

/**
 * **ローカルの `main` を指す書き方。**
 *
 * **完全修飾も同じ印を読む**（#699 のレビュー 2 周目）——**`/` の前を一律に外すと、
 * `git log refs/heads/main` が素通しする。** **外すのは上流の枝だけ**である
 * （`origin/main` / `refs/remotes/origin/main`）。
 */
const LOCAL_MAIN_REFS: ReadonlySet<string> = new Set(["main", "heads/main", "refs/heads/main"]);

/**
 * **名前として扱っている使い方を消す。** **残った `main` が版**である。
 *
 * **動詞の許可リストにしない**（#699 のレビュー）——**`git cherry main HEAD` のように、
 * 履歴を読む名前は列挙しきれない**。**列挙から漏れたコマンドは黙って通る**ので、
 * **向きを逆にして、名前として使っている形だけを除く。**
 */
function withoutNameUses(line: string): string {
  // **注釈を落としていない**——**落とさなくても本物の手順は緑**（変異で確かめた）で、
  // **拾う側は広いほうが安い**（#699 のレビュー）。**踏んだら足す。**
  return line
    .replace(/\b(fetch|push)\s+(origin|upstream)\s+main\b/g, "$1 $2") // 取りに行く先・送る先
    .replace(/(['"])(\^?)main\$?\1/g, "$1$2$1") // 一覧から名前で除く（`grep -v '^main$'`）
    .replace(/--base\s+main\b/g, "--base"); // PR の宛先
}

/**
 * **版として書かれた語**（範囲指定は両端に割り、`~` や引用符は落とす）。
 */
function revisions(line: string): readonly string[] {
  return line
    .split(/[\s;|&()'"`$]+/)
    .flatMap((word) => word.split(/\.{2,3}/))
    .map((word) => word.replace(/^[-^+@]+/, "").replace(/[~^@{}]\w*$/, ""));
}

/**
 * **版としてローカルの `main` を渡している行。**
 *
 * **`git` のコマンド行**か、**範囲指定**だけを見る。
 */
function staleRefLines(text: string): readonly string[] {
  return text.split("\n").filter((line) => {
    const rest = withoutNameUses(line);
    if (!revisions(rest).some((revision) => LOCAL_MAIN_REFS.has(revision))) {
      return false;
    }
    return /\bgit\s/.test(rest) || /\.\./.test(rest);
  });
}

/**
 * **打つ行だけを取り出す**（囲みブロックの中）。
 *
 * **散文は数えない**——**この手順書は、踏んだ形をそのまま引用して説明する**ので、
 * **説明の中の `git log main --` まで数えると、注意書きを書いた瞬間に赤くなる**
 * （**実際に赤くした**）。**害があるのは、人が写して打つ行**である。
 */
function commandLines(text: string): string {
  return [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1] ?? "").join("\n");
}

describe.each(ROLES)("%s の手順は、古い `main` を引かない", (role) => {
  it("版として `main` を渡している行が無い", () => {
    // **`main..<ブランチ>` で比べると、古い基準で数える**ことになる
    expect(staleRefLines(commandLines(procedureText(role))), "版として main を渡している").toEqual(
      [],
    );
  });

  it("作業場では `origin/main` で引く、と書いてある", () => {
    // **但し書きが無いと、次に履歴を引く人が同じ答えを静かに受け取る**
    // ——**2 人が別のコマンドで踏んでいる**（#697）
    expect(procedureText(role), "引き方の但し書きが無い").toContain(
      "作業場で履歴を引くときは `origin/main`",
    );
  });
});

describe("数える手そのもの", () => {
  // **本物の手順には、いま悪い行が無い**（#697 の実測: 2 件ともふつうの使い方）
  // ——**材料越しでは、この判定の狭さを測れない**（`AGENTS.md` §4 の 4 つ目）
  it("版として渡している形を見つける", () => {
    expect(staleRefLines("git log --oneline main..HEAD")).toHaveLength(1);
    expect(staleRefLines("git diff main...pr688 --stat")).toHaveLength(1);
    expect(staleRefLines("git merge-base main HEAD")).toHaveLength(1);
  });

  it("列挙していない動詞でも見つける", () => {
    // **動詞を並べると、並べ損ねたものが黙って通る**（#699 のレビュー）
    expect(staleRefLines("git cherry main HEAD")).toHaveLength(1);
    expect(staleRefLines("git range-diff main...HEAD")).toHaveLength(1);
    expect(staleRefLines("git rebase main")).toHaveLength(1);
    expect(staleRefLines("git bisect start HEAD main")).toHaveLength(1);
  });

  it("名前として扱っている形は数えない", () => {
    // **一覧から名前で除いているだけ**／**上流の枝名**——**どちらも古い印を読まない**
    expect(staleRefLines("git branch --format='%(refname:short)' | grep -v '^main$'")).toEqual([]);
    expect(staleRefLines("git fetch origin main")).toEqual([]);
    expect(staleRefLines("gh pr create --base main")).toEqual([]);
  });

  it("`main` を含む別の語は数えない", () => {
    // **`-` で切る**——**手順書のほぼ全行に出てくる**
    expect(staleRefLines('if ! after="$(bin/loop-sync-main)"; then')).toEqual([]);
    expect(staleRefLines("bin/loop-return-main # 枝の上で終えない")).toEqual([]);
  });

  it("完全修飾したローカルの印も数える", () => {
    // **`/` の前を一律に外すと、ここが素通しする**（#699 のレビュー 2 周目）
    expect(staleRefLines("git log refs/heads/main")).toHaveLength(1);
    expect(staleRefLines("git log heads/main..HEAD")).toHaveLength(1);
  });

  it("上流の枝は、完全修飾でも数えない", () => {
    expect(staleRefLines("git log refs/remotes/origin/main..HEAD")).toEqual([]);
    expect(staleRefLines("git log upstream/main")).toEqual([]);
  });

  it("`origin/main` は数えない", () => {
    expect(staleRefLines("git log --oneline origin/main..HEAD")).toEqual([]);
    expect(staleRefLines("git switch --detach origin/main")).toEqual([]);
    expect(staleRefLines("git rev-parse origin/main")).toEqual([]);
  });
});
