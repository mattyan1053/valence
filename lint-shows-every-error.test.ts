/**
 * **`./task check` が赤いとき、その原因が表示から消えない**（#526）。
 *
 * **2 周続けて踏んだ。** **`biome` は既定で 20 件しか出さない**ので、
 * **枠を埋めているのが既存の警告だと、新しく入れた誤りが押し出される**
 * ——**「あと N 件あります」だけが残る。**
 *
 * **危ないのは、見えている行を原因だと読むこと**である。**出ているのは既存の警告**
 * なので、**直しても赤いまま**——**「直したのに落ちる」で時間が溶ける。**
 *
 * **入力に踏む形を置く** (`AGENTS.md` §4)。**わざと上限を超える数の警告を作り**、
 * **その後ろに誤りを 1 つ置いて**、**それが出るかを見る。**
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL(".", import.meta.url));

/** **上限（既定 20）より多く**。**枠を埋めるのは、いつも既存のぶん**である。 */
const WARNINGS = 30;

/** **後ろに置く。** **押し出されるのは、並びの後ろ**である。 */
const ERROR_FILE = "zz-error.ts";

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** **本物の `lint` を読む**——**写すと、片方だけ直したときに食い違う**（`AGENTS.md` §5）。 */
function lintScript(): string {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const script = manifest.scripts?.lint;
  expect(script, "package.json に lint が無い").toBeTruthy();
  return script as string;
}

/** 警告を上限より多く出し、その後ろに誤りを 1 つ置いた砂場。 */
function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "lint-limit-"));
  sandboxes.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "biome.json"),
    `${JSON.stringify(
      {
        $schema: "https://biomejs.dev/schemas/2.5.10/schema.json",
        linter: {
          enabled: true,
          rules: {
            recommended: false,
            correctness: { noUnusedImports: "warn" },
            suspicious: { noDebugger: "error" },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  for (let index = 0; index < WARNINGS; index += 1) {
    writeFileSync(
      join(dir, "src", `warn-${String(index).padStart(2, "0")}.ts`),
      'import { join } from "node:path";\nexport const value = 1;\n',
    );
  }
  writeFileSync(join(dir, "src", ERROR_FILE), "export function stop() {\n  debugger;\n}\n");
  return dir;
}

describe("lint が赤いときの出力", () => {
  it("警告が上限を超えていても、誤りの場所が出る", () => {
    const dir = sandbox();

    const ran = spawnSync("sh", ["-c", lintScript()], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(REPO_ROOT, "node_modules/.bin")}:${process.env.PATH ?? ""}`,
      },
    });
    const output = `${ran.stdout}${ran.stderr}`;

    // **この試験が成立しているか**——**赤くないなら、何も見ていない**
    expect(ran.status, `赤くなっていない: ${output}`).not.toBe(0);

    // **消えたものが 1 件も無いこと。** **「あと N 件あります」で終わらせない**
    // （#526 の完了条件）——**その 1 行が出ている時点で、原因は消えうる。**
    expect(output, "表示から消したものがある").not.toMatch(/not shown|exceeds the limit/);
    // **端まで出ていること**（**上限を外したなら、最初も最後も出る**）
    expect(output, "警告の始めが出ていない").toContain("warn-00.ts");
    expect(output, "警告の終わりが出ていない").toContain(`warn-${WARNINGS - 1}.ts`);
    expect(output, "誤りの場所が出ていない").toContain(ERROR_FILE);
  }, 20_000);
});
