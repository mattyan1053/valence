import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/** `./task loop:setup` が用意する label（実装側の正）。 */
function labelsCreatedBySetup(): string[] {
  const match = read("task").match(/for label in ([^;]+); do/);
  if (match?.[1] === undefined) {
    throw new Error("task の loop:setup から label の一覧を読み取れません");
  }
  return match[1].trim().split(/\s+/);
}

/** `loop/README.md` の label 表に並ぶ label（運用側の正）。 */
function labelsDocumentedInReadme(): string[] {
  const table = read("loop/README.md").split("\n## label\n")[1]?.split("\n## ")[0];
  if (table === undefined) {
    throw new Error("loop/README.md に label の節がありません");
  }
  return [...table.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((row) => row[1] ?? "");
}

/**
 * Issue を作るテンプレートの一覧。
 * **`labels` の有無で絞らない。** 書き忘れたファイルが検査対象から消えると、
 * この PR が防ごうとしている「起票が黙って落ちる」をそのまま素通しする。
 * 除外するのは `config.yml` だけで、これは Issue を作らない設定ファイルだからである。
 */
function templateFiles(): string[] {
  return execFileSync("git", ["ls-files", ".github/ISSUE_TEMPLATE/*.yml"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter((path) => path !== "" && basename(path) !== "config.yml");
}

/** そのテンプレートが起票時に付ける label。`labels` が無ければ 0 件。 */
function labelsOf(file: string): string[] {
  const match = read(file).match(/^labels:\s*\[([^\]]*)\]/m);
  return (match?.[1] ?? "")
    .split(",")
    .map((label) => label.trim().replace(/^["']|["']$/g, ""))
    .filter((label) => label !== "");
}

/** Issue テンプレートが起票時に付ける label（ファイル付き）。 */
function labelsUsedInTemplates(): { file: string; label: string }[] {
  return templateFiles().flatMap((file) => labelsOf(file).map((label) => ({ file, label })));
}

/** 追跡下の Markdown が `gh issue` に渡している label。 */
function labelsUsedInDocs(): { file: string; label: string }[] {
  const files = execFileSync("git", ["ls-files", "*.md"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter((path) => path !== "");

  const pattern = /--(?:add-|remove-)?label[ =]([a-z][a-z0-9-]*)/g;
  return files.flatMap((file) =>
    [...read(file).matchAll(pattern)].map((match) => ({ file, label: match[1] ?? "" })),
  );
}

describe("ループが使う label", () => {
  it("loop/README.md の表の label は `./task loop:setup` が用意する", () => {
    const prepared = new Set(labelsCreatedBySetup());

    expect(labelsDocumentedInReadme().filter((label) => !prepared.has(label))).toEqual([]);
  });

  it("表に無い label を用意するのは、テンプレートが使うものだけ", () => {
    // 用意する label が増えっぱなしにならないよう、余分は使い道で説明できることを要求する
    const documented = new Set(labelsDocumentedInReadme());
    const usedByTemplates = new Set(labelsUsedInTemplates().map(({ label }) => label));

    const extra = labelsCreatedBySetup().filter(
      (label) => !documented.has(label) && !usedByTemplates.has(label),
    );

    expect(extra).toEqual([]);
  });

  it("Issue テンプレートが付ける label はすべて用意されている", () => {
    // 存在しない label を書いても GitHub はエラーにせず**黙って落とす**。
    // 起票した人は登録したつもりのまま、どの一覧にも現れない
    const prepared = new Set(labelsCreatedBySetup());

    expect(labelsUsedInTemplates().filter(({ label }) => !prepared.has(label))).toEqual([]);
  });

  it("Issue テンプレートは起票を backlog に入れる", () => {
    // master は backlog / ready / in-progress しか見ない。ここが抜けると
    // 人の起票が候補から漏れ、master は「作業が無い」と判断して別の作業を起票する。
    // **labels を書き忘れたファイルも「足りない」として落とす**
    const missing = templateFiles().filter((file) => !labelsOf(file).includes("backlog"));

    expect(missing).toEqual([]);
  });

  it("手順書が渡す label はすべて用意されている", () => {
    const known = new Set(labelsCreatedBySetup());

    expect(labelsUsedInDocs().filter(({ label }) => !known.has(label))).toEqual([]);
  });
});
