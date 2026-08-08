import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  it("`./task loop:setup` が作る label と loop/README.md の表が一致する", () => {
    expect([...labelsCreatedBySetup()].sort()).toEqual([...labelsDocumentedInReadme()].sort());
  });

  it("手順書が渡す label はすべて用意されている", () => {
    const known = new Set(labelsCreatedBySetup());

    expect(labelsUsedInDocs().filter(({ label }) => !known.has(label))).toEqual([]);
  });
});
