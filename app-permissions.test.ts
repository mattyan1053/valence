/**
 * **この道具が GitHub App に要求する権限を、リポジトリの中に持つ**（#518）。
 *
 * **権限は `.env` では決まらない。** **GitHub の App 設定画面にある**——**リポジトリの
 * 外**である。**能力が増えても、権限を更新する場所が無かった**（`AGENTS.md` §5 の
 * 「残る側を数える」が、リポジトリの外で起きている形）。
 *
 * **「書いて終わり」にしない。** **叩く口はコードにある**ので、**そこから数えて、
 * 表に出ているかを見る**——**口を足したら、表に足すまで赤くなる。**
 *
 * ## この試験が測っていないこと（#523 のレビュー）
 *
 * **ここに並べてあるのは、素通りする道である。** **次に穴を塞ぐ人は、ここから読める。**
 *
 * - **HTTP の動詞。** **表は動詞込みで並べている**が、**突き合わせているのはパスだけ**
 *   ——**同じパスに別の動詞を足すと通る**（**`PATCH /repos/{owner}/{repo}` は
 *   Administration が要る**のに、**`GET` の行に当たって緑**になる）。
 *   **塞ぐには、口を `fetch` の呼び出しから拾い直し、第 2 引数の `method` と
 *   組にする必要がある**——**いまは文字列を数えているだけ**なので、**別の集め方**になる。
 *   **`GET` は `method` を書かない**（既定）ので、**「書いていない＝GET」も仮定になる。**
 * - **GraphQL の操作ごとの権限。** **`POST /graphql` は 1 つの口**だが、
 *   **要る権限は問い合わせごとに変わる**——**URL では区別できない。**
 *   **Issues を読むフィールドを足しても、`Pull requests` の行に当たって緑**である。
 *   **これは #518 の外**（**「叩く口が表に出ている」は満たせる**）——
 *   **必要になったら別の Issue に切り出す。**
 * - **読みと書きの別。** **`POST /graphql` は読み**なので、**動詞からは決まらない。**
 *   **そこは人が書き、レビューが見る。**
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL(".", import.meta.url));
const GITHUB_DIR = join(REPO_ROOT, "src/infrastructure/github");

/** README の、権限を書いた節。**次の見出しまで。** */
function permissionsSection(): string {
  const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
  const from = readme.indexOf("## GitHub App に要る権限");
  expect(from, "権限の節が README に無い").toBeGreaterThanOrEqual(0);
  const rest = readme.slice(from);
  const end = rest.slice(1).search(/\n## /);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

/**
 * **足りないときに何が起きるかを書いたところ。** **節ごと見ない**（`AGENTS.md` §4）。
 *
 * **`unavailable` は節の中に 2 回出る**——**症状の行と、「見たら見直す」の行**。
 * **症状の行を消しても、もう片方に当たって緑**だった（#523 のレビュー 2 周目）。
 *
 * **段落で切っても足りない**——**2 つは同じ段落にある**（**間に空行が無い**）。
 * **次の一手を書いた行の手前まで**にする。
 */
function symptomParagraph(): string {
  const section = permissionsSection();
  const from = section.indexOf("**足りないとどうなるか。**");
  expect(from, "症状を書いたところが無い").toBeGreaterThanOrEqual(0);
  const rest = section.slice(from);
  // **次の一手（「見たら見直す」）は、症状ではない**——**含めると範囲が広がる**
  const until = rest.indexOf("**`unavailable` を見たら");
  return until < 0 ? rest : rest.slice(0, until);
}

/**
 * **口の書き方を 1 つに揃える。** **`{owner}` も `${number}` も、埋める場所**である
 * ——**名前ではなく形で突き合わせる。**
 */
function normalize(path: string): string {
  return (
    path
      .replace(/\$\{API_ORIGIN\}/g, "")
      .replace("https://api.github.com", "")
      // **`repositoryUrl()` だけは、口の名前から展開する** (`repository-url.ts`)
      // ——**コード側はこの関数で `/repos/{owner}/{repo}` を隠している。**
      .replace(/\$\{repositoryUrl\([^)]*\)\}/g, "/repos/{}/{}")
      .replace(/\$\{[^}]*\}/g, "{}")
      .replace(/\{[a-z_]+\}/gi, "{}")
      .split("?")[0]
      ?.trim() as string
  );
}

/** **コメントを外す。** **例として書いた URL を、叩く口と数えない。** */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * **口として数えるか。**
 *
 * **繋ぐための断片は数えない**（`${base}${path}` の左側——**右側が口である**）。
 * **繋ぎ目そのものも口ではない**（`${API_ORIGIN}/` の見張りなど）。
 */
function looksLikeEndpoint(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("{}{}") && path !== "/";
}

/** その版が叩く口。**文字列として書かれているものを、そのまま拾う。** */
function endpointsIn(source: string): string[] {
  return [...withoutComments(source).matchAll(/`([^`]*)`|"([^"\n]*)"|'([^'\n]*)'/g)]
    .map(([, backtick, double, single]) => normalize(backtick ?? double ?? single ?? ""))
    .filter(looksLikeEndpoint);
}

function endpointsInFile(name: string): string[] {
  return endpointsIn(readFileSync(join(GITHUB_DIR, name), "utf8"));
}

/** **コードが叩く口。** **`src/infrastructure/github/` の中だけ**（外へ出る口はここ）。 */
function endpointsInCode(): string[] {
  const files = readdirSync(GITHUB_DIR).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  );
  const found = new Set(files.flatMap(endpointsInFile));

  expect([...found], "叩く口が 1 つも見つからない（この試験は何も見ていない）").not.toEqual([]);
  return [...found].sort();
}

/** **表に書いてある口。** **行そのものを返す**（権限も同じ行にある）。 */
function documentedEndpoints(): { path: string; line: string }[] {
  return permissionsSection()
    .split("\n")
    .flatMap((line) =>
      // **1 行に複数書く**（**同じ権限で通る口は、まとめて並べる**）——**全部拾う。**
      [...line.matchAll(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s`,、）]+)/g)].map((match) => ({
        path: normalize(match[1] ?? ""),
        line,
      })),
    );
}

describe("叩く口を拾う", () => {
  // **拾えない書き方があると、そこだけ表を更新しなくても緑になる**（#523 のレビュー）
  // ——**この試験が守りたいのは「口を足したら赤くなる」**である。
  it("バッククォートで書かれた口を拾う", () => {
    expect(endpointsIn("await fetch(`${API_ORIGIN}/user/repos`);")).toContain("/user/repos");
  });

  it("ダブルクォートで書かれた口も拾う", () => {
    // **先例がある**——**同じディレクトリの `user-token.ts` は `"..."` で URL を持つ。**
    // **次に誰かが同じ書き方で口を足したら、表を更新しなくても緑**だった。
    const source = 'const URL = "https://api.github.com/repos/{owner}/{repo}/issues";';

    expect(endpointsIn(source)).toContain("/repos/{}/{}/issues");
  });

  it("シングルクォートで書かれた口も拾う", () => {
    const source = "const URL = 'https://api.github.com/user/repos';";

    expect(endpointsIn(source)).toContain("/user/repos");
  });

  it("コメントの中の口は、これまでどおり数えない", () => {
    // **例として書いた URL を、叩く口と数えない**（引用符を増やしても変わらないこと）
    const source = '// 例: "https://api.github.com/repos/{owner}/{repo}/issues"\n';

    expect(endpointsIn(source)).toEqual([]);
  });
});

describe("GitHub App に要る権限", () => {
  it("叩く口が、すべて表に出ている", () => {
    // **能力を足したら、表に足すまで赤くなる**（#518 の完了条件の 3 つ目）
    // ——**「手順書に書く」だけでは踏み外す**（#143 / #319）。
    const documented = documentedEndpoints();
    expect(documented, "表に口が 1 つも書かれていない").not.toEqual([]);

    // **口は末尾で突き合わせる**——**`repositoryUrl()` を通す口と、
    // `${base}` へ足す断片（`/pulls/{}/files`）が、同じ形で並ぶ。**
    const missing = endpointsInCode().filter(
      (path) => !documented.some(({ path: doc }) => doc === path || doc.endsWith(path)),
    );

    expect(missing, "表に無い口を叩いている（権限を見直すこと）").toEqual([]);
  });

  it("表にあってコードに無い口が残っていない", () => {
    // **消す側も測る**（#523 のレビュー 2 周目。`AGENTS.md` §5「残る側を数える」）
    // ——**口を消すと `endpointsInCode()` が縮むだけ**で、**表に古い行が残っても緑**だった。
    //
    // **残るのは「要らない権限」**である。**Merge の実装を消しても
    // `Contents: Read and write` が要求のまま残り**、**利用者は書き込み権限を
    // 与え続ける**——**#518 が欲しいのは「必要な権限が揃うこと」**なので、
    // **多いのも外れ**である。
    const code = endpointsInCode();

    const stale = documentedEndpoints()
      .map(({ path }) => path)
      .filter((doc) => !code.some((path) => doc === path || doc.endsWith(path)));

    expect(stale, "コードが叩いていない口が表に残っている（権限を見直すこと）").toEqual([]);
  });

  it("足りないときに何が起きるかが書いてある", () => {
    // **`unavailable` を見た人が、権限を疑えること**（完了条件の 2 つ目）
    //
    // **節ごと見ない**（#523 のレビュー 2 周目。`AGENTS.md` §4）——**`unavailable` は
    // 節の中に 2 行ある**（**症状の行と、「見たら見直す」の行**）ので、
    // **症状のほうを消しても、もう片方に当たって緑**だった。**打つ行へ寄せる。**
    const symptom = symptomParagraph();

    // **数えるのは、判定と同じ場所である**（§4）——**範囲の中に 2 つあるなら、
    // 片方を消しても緑**になる。**範囲が広がったら、ここで赤くなる。**
    expect(symptom.match(/unavailable/g) ?? [], "判定の範囲が広い").toHaveLength(1);
    expect(symptom, "断られたときの応答が書かれていない").toContain("403");
    expect(symptom, "画面に何が出るかが書かれていない").toContain("unavailable");
  });
});
