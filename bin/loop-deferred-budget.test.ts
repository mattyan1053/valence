import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-deferred-budget", import.meta.url));

describe("bin/loop-deferred-budget", () => {
  let dir: string;
  let path: string;

  /** 偽の `gh`。**open かつ `deferred-finding` の件数だけ**を返す。 */
  function withOpenDeferred(count: number | "fails"): void {
    writeFileSync(
      join(path, "gh"),
      count === "fails"
        ? '#!/usr/bin/env bash\necho "gh が落ちた" >&2\nexit 1\n'
        : [
            "#!/usr/bin/env bash",
            // **閉じたものを数えない。** `--state open` を落とす変異を捕まえる
            'if [[ $* != *"--state open"* ]]; then',
            '  echo "スタブ: open に絞っていない: $*" >&2',
            "  exit 3",
            "fi",
            'if [[ $* != *"deferred-finding"* ]]; then',
            '  echo "スタブ: label で絞っていない: $*" >&2',
            "  exit 3",
            "fi",
            // **`--limit` は「取ってくる上限」である。** 本物の `gh` と同じく、
            // ここで丸める。丸めを再現しないと、**取りこぼしても緑のまま**になる
            "limit=0",
            "while (($# > 0)); do",
            '  [[ $1 == "--limit" ]] && limit="$2"',
            "  shift",
            "done",
            `count=${count}`,
            'if ((count > limit)); then count="$limit"; fi',
            'echo "$count"',
          ].join("\n"),
      { mode: 0o755 },
    );
  }

  function run(env: Record<string, string> = {}): { status: number; stderr: string } {
    const result = spawnSync(SCRIPT, [], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: path, ...env },
      timeout: 20_000,
    });
    return { status: result.status ?? -1, stderr: result.stderr ?? "" };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loop-deferred-"));
    path = join(dir, "path");
    mkdirSync(path, { recursive: true });
    for (const command of ["bash", "cat", "grep"]) {
      const found = spawnSync("which", [command], { encoding: "utf8" }).stdout.trim();
      if (found !== "") {
        symlinkSync(found, join(path, command));
      }
    }
    chmodSync(path, 0o755);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("既定の 5 件までは通す", () => {
    // **既定をマージにする以上、歯止めはここにしかない**（#73）
    withOpenDeferred(5);

    expect(run().status).toBe(0);
  });

  it("既定を超えたら人を呼ぶ", () => {
    withOpenDeferred(6);

    const over = run();

    expect(over.status).toBe(1);
    expect(over.stderr).toContain("6");
  });

  it("閾値は環境変数で変えられる", () => {
    // 既定の 5 は「人が 1 回座って読み切れる量」でしかなく、**正確な値ではない**
    withOpenDeferred(6);

    expect(run({ LOOP_DEFERRED_MAX: "10" }).status).toBe(0);
    expect(run({ LOOP_DEFERRED_MAX: "5" }).status).toBe(1);
  });

  it("上限より多く取ってきて数える", () => {
    // **`--limit` は取得件数の上限**なので、そこで丸められると
    // **上限ちょうどに見えて歯止めが効かない**。上限を超えているかを知るには
    // 上限より 1 件多く取れればよい
    withOpenDeferred(201);

    expect(run({ LOOP_DEFERRED_MAX: "200" }).status).toBe(1);
  });

  it("件数を読めなければ 2 で落ちる", () => {
    // **判定不能を「まだ余裕がある」に倒さない。** 倒すと歯止めが静かに消える
    withOpenDeferred("fails");

    expect(run().status).toBe(2);
  });

  it("閾値の設定が壊れていれば 2 で落ちる", () => {
    withOpenDeferred(1);

    expect(run({ LOOP_DEFERRED_MAX: "たくさん" }).status).toBe(2);
  });
});
