/**
 * **この道具が GitHub App に要求する権限を、リポジトリの中に持つ**（#518）。
 *
 * **権限は `.env` では決まらない。** **GitHub の App 設定画面にある**——**リポジトリの
 * 外**である。**能力が増えても、権限を更新する場所が無かった**（`AGENTS.md` §5 の
 * 「残る側を数える」が、リポジトリの外で起きている形）。
 *
 * **「書いて終わり」にしない。** **叩く口はコードにある**ので、**そこから数えて、
 * 表に出ているかを見る**——**口を足したら、表に足すまで赤くなる。**
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
function endpointsInFile(name: string): string[] {
  const source = withoutComments(readFileSync(join(GITHUB_DIR, name), "utf8"));
  return [...source.matchAll(/`([^`]*)`/g)]
    .map(([, literal]) => normalize(literal ?? ""))
    .filter(looksLikeEndpoint);
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

  it("足りないときに何が起きるかが書いてある", () => {
    // **`unavailable` を見た人が、権限を疑えること**（完了条件の 2 つ目）
    const section = permissionsSection();

    expect(section, "断られたときの応答が書かれていない").toContain("403");
    expect(section, "画面に何が出るかが書かれていない").toContain("unavailable");
  });
});
