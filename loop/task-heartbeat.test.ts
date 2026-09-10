import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * **`./task` は、心拍を「始まり」と「終わり」の両方で打つ**（#676）。
 *
 * **測った**（2026-09-11、この作業場）。**`./task check` の最中、活動の記録は
 * 1 度しか書かれない**——**`main` の前置きで打つ 1 回だけ**である。
 * **単独で 1036 秒、別の作業場と重なると更に延びる**（`task` の但し書きの実測）。
 *
 * **切れるのは check の中ではない。** **TTL は 1800 秒**なので、**1036 秒では
 * 切れない**——**切れたのは「check + そのあと `bin/loop-*` を打たない区間」**である
 * （**実測の超過は 25 / 212 / 494 秒**、つまり**無心拍が 1825 / 2012 / 2294 秒**）。
 * **終わりにもう 1 度打てば、check のぶんは次の区間へ持ち越されない。**
 *
 * **背景で打ち続ける形にはしない**（`task` の `heartbeat()` の但し書き）——
 * **死んだ周回の心臓が動き続ける。** **前景で 1 回増やすだけ**である。
 */
describe("./task の心拍", () => {
  it("コマンドが終わったあとにも打つ", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "task-heartbeat-"));
    const beats = join(sandbox, "beats");
    mkdirSync(join(sandbox, "bin"), { recursive: true });
    copyFileSync(join(REPO_ROOT, "task"), join(sandbox, "task"));
    const stub = join(sandbox, "bin/loop-lease");
    writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >>${JSON.stringify(beats)}\n`);
    chmodSync(stub, 0o755);

    // **前置きのうち、心拍以外は黙らせる**（見たいのは打った回数だけ）。
    // **`main` を通す**——**`heartbeat` を直接 2 回呼んでも、配線は確かめられない。**
    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          "source ./task",
          "ensure_commit_guard() { :; }",
          "warn_stale_containers() { :; }",
          "cmd_slow() { :; }",
          "main slow",
        ].join("\n"),
      ],
      { cwd: sandbox, encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    const written = existsSync(beats) ? readFileSync(beats, "utf8").trimEnd().split("\n") : [];
    expect(written, "心拍が打たれていない").not.toEqual([]);
    expect(
      written.length,
      "心拍が始まりの 1 回だけ。長いコマンドのぶんが、そのまま無心拍の区間になる",
    ).toBe(2);
  });

  it("落ちたコマンドの終了コードを、心拍で塗り替えない", () => {
    // **合否は打ったコマンドのもの**である（`AGENTS.md` §4 の「終了コードで決める」）。
    // **心拍を挟むと、最後に走ったコマンドの終了コードが `$?` になる**
    // ——**そのまま返すと、赤い `./task check` が緑になる**（**押し通した先で
    // push まで通る**）。
    const sandbox = mkdtempSync(join(tmpdir(), "task-heartbeat-status-"));
    mkdirSync(join(sandbox, "bin"), { recursive: true });
    copyFileSync(join(REPO_ROOT, "task"), join(sandbox, "task"));
    const stub = join(sandbox, "bin/loop-lease");
    // **心拍そのものは成功する**——**見たいのは、成功が合否を上書きしないこと。**
    writeFileSync(stub, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(stub, 0o755);

    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          "source ./task",
          "ensure_commit_guard() { :; }",
          "warn_stale_containers() { :; }",
          "cmd_red() { return 3; }",
          "main red",
        ].join("\n"),
      ],
      { cwd: sandbox, encoding: "utf8" },
    );

    expect(result.status, "落ちたコマンドの終了コードが消えている").toBe(3);
  });
});
