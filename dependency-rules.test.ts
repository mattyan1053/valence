/**
 * **依存の規則そのものを、違反する木で確かめる**（#691 のレビュー）。
 *
 * **規則を消しても、いまの依存グラフには違反が無い**ので、**`pnpm depcruise` は
 * 通り続ける**——**手で戻して確かめた 1 回は残らない。** **守りが壊れても、
 * 別のルート間依存が入るまで気づけない。**
 *
 * **小さな木を作って、本物の設定で走らせる**——**規則の名前で落ちること**と、
 * **落としてはいけない形で落ちないこと**の両方を見る。
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL(".", import.meta.url));
const CONFIG = join(REPO, ".dependency-cruiser.mjs");
const DEPCRUISE = join(REPO, "node_modules", ".bin", "depcruise");

/** **本物の設定で、その木を検査する。** */
function cruise(sandbox: string): { status: number; out: string } {
  const run = spawnSync(DEPCRUISE, ["--config", CONFIG, "src"], {
    cwd: sandbox,
    encoding: "utf8",
  });
  return { status: run.status ?? -1, out: `${run.stdout}${run.stderr}` };
}

describe("ルートの入口は、ほかから import できない", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "dependency-rules-"));
    // **本物の設定は tsconfig を読む**——**無いと、検査そのものが立ち上がらない**
    writeFileSync(
      join(sandbox, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          jsx: "react-jsx",
          module: "esnext",
          moduleResolution: "bundler",
          target: "es2022",
        },
      }),
    );
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  function write(path: string, body: string): void {
    const full = join(sandbox, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }

  it("ルート同士が import し合うと、規則の名前で落ちる", () => {
    // **#690 で実際に踏んだ形**——**入口の画面が、別のルートの `page.tsx` から
    // 判定を import していた**
    write("src/app/repos/x/page.tsx", 'export function judge(): string {\n  return "x";\n}\n');
    write(
      "src/app/page.tsx",
      'import { judge } from "./repos/x/page";\n\nexport const home = judge;\n',
    );

    const { status, out } = cruise(sandbox);

    expect(status, "違反しているのに通っている").not.toBe(0);
    expect(out).toContain("app-routes-are-not-imported");
  });

  it("名前が `route` で終わるだけの普通のモジュールは、落ちない", () => {
    // **`[^?]*(page|route)` だと `candidate-route.ts` にも当たる**（#691 のレビュー）
    // ——**規則の文言と、実際に落ちるものが食い違う**
    write("src/app/repos/candidate-route.ts", "export const candidate = 1;\n");
    write(
      "src/app/page.tsx",
      'import { candidate } from "./repos/candidate-route";\n\nexport const home = candidate;\n',
    );

    const { status, out } = cruise(sandbox);

    expect(status, out).toBe(0);
  });

  it("同じルートの中の、入口でないモジュールは、これまでどおり import できる", () => {
    // **`approve/route.ts` が `../board-redirect` を読む形**（既にある）
    write("src/app/repos/x/board-redirect.ts", "export const redirect = 1;\n");
    write(
      "src/app/repos/x/approve/route.ts",
      'import { redirect } from "../board-redirect";\n\nexport const POST = redirect;\n',
    );

    const { status, out } = cruise(sandbox);

    expect(status, out).toBe(0);
  });
});
