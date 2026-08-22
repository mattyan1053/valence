/**
 * **イメージが古いことを、使う前に知らせる**（#380）。
 *
 * **`Dockerfile` に何かを足した PR がマージされても、走っている作業場は
 * 古いイメージのまま動き続ける**——**気づくのは、そのぶんが要る検査が落ちたとき**である
 * （#379 で ShellCheck を `./task check` へ入れなかったのは、まさにこれが無いため）。
 *
 * **比べるのは、イメージに焼き込まれるファイルの内容**である。**指紋はイメージの
 * ラベルに残す**——**残る側はイメージ**（`AGENTS.md` §5）。
 */

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./image-drift", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 写した checkout を作る。**実物の `Dockerfile` を触らない。**
 *
 * `label` は偽の `docker` が返す値。`null` なら「そのイメージは無い」。
 */
function checkout(options: { dockerfile?: string; label?: string | null } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "image-drift-"));
  sandboxes.push(dir);
  mkdirSync(join(dir, "bin"), { recursive: true });
  copyFileSync(SCRIPT, join(dir, "bin", "image-drift"));
  chmodSync(join(dir, "bin", "image-drift"), 0o755);
  writeFileSync(join(dir, "Dockerfile"), options.dockerfile ?? "FROM node:24\n");
  writeFileSync(join(dir, "docker-entrypoint.sh"), '#!/usr/bin/env bash\nexec "$@"\n');
  const stub = join(dir, "stub");
  mkdirSync(stub, { recursive: true });
  writeFileSync(
    join(stub, "docker"),
    options.label === null
      ? '#!/usr/bin/env bash\necho "No such image" >&2\nexit 1\n'
      : `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(options.label ?? "")}\nexit 0\n`,
    { mode: 0o755 },
  );
  return dir;
}

function run(
  dir: string,
  args: string[],
  withDocker = true,
): { status: number; stderr: string; stdout: string } {
  const result = spawnSync(join(dir, "bin", "image-drift"), args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(dir, "stub")}:${process.env.PATH ?? ""}`,
      // **呼ぶものを差し替える**（PATH を壊すと、bash も見つからなくなる）
      LOOP_DOCKER: withDocker ? "docker" : "docker-does-not-exist",
    },
  });
  return { status: result.status ?? -1, stderr: result.stderr, stdout: result.stdout };
}

describe("bin/image-drift", () => {
  it("同じ入力なら、同じ指紋になる", () => {
    const a = checkout();
    const b = checkout();

    expect(run(a, ["digest"]).stdout).toBe(run(b, ["digest"]).stdout);
  });

  it("Dockerfile が変われば、指紋も変わる", () => {
    const a = checkout();
    const b = checkout({ dockerfile: "FROM node:24\nRUN apt-get install -y shellcheck\n" });

    expect(run(a, ["digest"]).stdout).not.toBe(run(b, ["digest"]).stdout);
  });

  it("指紋が同じなら、何も言わない", () => {
    const dir = checkout();
    const digest = run(dir, ["digest"]).stdout.trim();
    const same = checkout({ label: digest });

    const result = run(same, ["check", "valence-app"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr, "同じなのに鳴っている").toBe("");
  });

  it("指紋が違えば、作り直し方を出す", () => {
    const dir = checkout({ label: "前の指紋" });

    const result = run(dir, ["check", "valence-app"]);

    expect(result.status).toBe(1);
    expect(result.stderr, "作り直し方が出ていない").toContain("./task build");
  });

  it("ラベルが無いイメージも、古い側へ倒す", () => {
    // **この仕組みより前に作られたイメージ**——**「分からない」は「新しい」ではない**
    const dir = checkout({ label: "" });

    const result = run(dir, ["check", "valence-app"]);

    expect(result.status).toBe(1);
    expect(result.stderr, "いつの build か分からないことを言っていない").toContain("分かりません");
  });

  it("そのイメージがまだ無ければ、何も言わない", () => {
    // **これから compose が作る**——**「古い」ではない**（**毎周回鳴らせない**）
    const dir = checkout({ label: null });

    const result = run(dir, ["check", "valence-app"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("docker が無ければ、分からないと言う", () => {
    // **「古くない」へ倒さない**（#210 の向き）
    const dir = checkout();

    expect(run(dir, ["check", "valence-app"], false).status).toBe(2);
  });

  it("使い方の誤りは、緑にしない", () => {
    const dir = checkout();

    expect(run(dir, []).status).toBe(2);
    expect(run(dir, ["check"]).status).toBe(2);
    expect(run(dir, ["digest", "余計"]).status).toBe(2);
  });

  it("実物の checkout でも、指紋を出せる", () => {
    const result = spawnSync(SCRIPT, ["digest"], { cwd: REPO_ROOT, encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stdout.trim(), "指紋の形が違う").toMatch(/^[0-9a-f]{64}$/);
  });
});
