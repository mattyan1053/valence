/**
 * **起動だけをやり直す**（#366）。
 *
 * **`database policies` は、runner の都合で落ちることがある**——**Supabase が使う
 * 543xx は Linux の一時ポート範囲の内側**にあり、**`supabase start` 自身が張る
 * 外向き接続の 1 本が 54322 を掴んだまま bind へ進むと落ちる**
 * （実測 2 回。`failed to bind host port for 0.0.0.0:54322`）。
 *
 * **PR の中身とは関係が無い**ので、**worker へ渡すと 1 往復まるごと無駄になる。**
 *
 * **やり直してよいのは起動だけ**である——**試験まで広げると、落ちているのに緑になる**
 * （#210 と同じ向き）。**その線引きをここで見る。**
 *
 * **本物の Supabase は起こさない。** **`pnpm` を差し替えて、落ち方だけを決める**
 * ——**走っているものと競らない**（`AGENTS.md` §5）。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./db-start", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 実測の文面。**書き換えたら、この試験は本物と別のものを見ている。** */
const BIND_FAILURE =
  "failed to bind host port for 0.0.0.0:54322:172.18.0.2:5432/tcp: address already in use";

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * **起動のたびに、決めた落ち方をする `pnpm`。**
 *
 * `plan` は 1 回目・2 回目…の結果である（`ok` / `bind` / `other`）。
 * **呼ばれた引数はすべて記録する**——**「やり直していない」も「止めていない」も、
 * ここでしか見えない。**
 */
function withPnpm(plan: ("ok" | "bind" | "other")[]): { dir: string; log: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), "db-start-"));
  sandboxes.push(dir);
  const log = join(dir, "pnpm.log");
  const count = join(dir, "count");
  writeFileSync(join(dir, "plan"), `${plan.join("\n")}\n`);
  writeFileSync(
    join(dir, "pnpm"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      'if [[ "$*" != *"supabase start"* ]]; then exit 0; fi',
      `n=$(cat ${JSON.stringify(count)} 2>/dev/null || echo 0)`,
      "n=$((n + 1))",
      `printf '%s' "$n" > ${JSON.stringify(count)}`,
      `plan="$(sed -n "\${n}p" ${JSON.stringify(join(dir, "plan"))})"`,
      "case $plan in",
      "  ok) echo 'started'; exit 0 ;;",
      `  bind) echo ${JSON.stringify(BIND_FAILURE)} >&2; exit 1 ;;`,
      "  *) echo 'migration failed: relation does not exist' >&2; exit 1 ;;",
      "esac",
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    dir,
    log: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
  };
}

function runStart(dir: string, attempts = 3) {
  return spawnSync(SCRIPT, [], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      DB_START_ATTEMPTS: String(attempts),
      // **待たない**（試験の中で待つ理由が無い）。**本物の既定はスクリプトが持つ。**
      DB_START_WAIT_SEC: "0",
    },
  });
}

const startsIn = (lines: string[]) =>
  lines.filter((line) => line.includes("supabase start")).length;
const stopsIn = (lines: string[]) => lines.filter((line) => line.includes("supabase stop")).length;

describe("bin/db-start", () => {
  it("ポートの衝突なら、やり直して起動する", () => {
    // **これが無いと、PR の中身と関係のない失敗が worker へ渡る**（#366）
    const { dir, log } = withPnpm(["bind", "ok"]);

    const done = runStart(dir);

    expect(done.status, `${done.stdout}\n${done.stderr}`).toBe(0);
    expect(startsIn(log()), "やり直していない").toBe(2);
    // **残骸を残したまま上げ直さない**——**半分起きた状態が次の bind を塞ぐ**
    expect(stopsIn(log()), "やり直す前に落としていない").toBeGreaterThanOrEqual(1);
  });

  it("別の理由で落ちたら、やり直さない", () => {
    // **やり直してよいのは runner の都合だけ**である——**本物の失敗を繰り返しても
    // 通らないし、通ってしまうなら、それは隠したことになる**
    const { dir, log } = withPnpm(["other", "ok"]);

    const done = runStart(dir);

    expect(done.status, "落ちていない").not.toBe(0);
    expect(startsIn(log()), "やり直している").toBe(1);
  });

  it("やり直しても同じなら、赤で終わる", () => {
    // **無限にやり直さない**——**塞いでいるのが runner でないなら、人が要る**
    const { dir, log } = withPnpm(["bind", "bind", "bind", "ok"]);

    const done = runStart(dir, 3);

    expect(done.status, "緑で終わっている").not.toBe(0);
    expect(startsIn(log()), "回数の上限が効いていない").toBe(3);
  });

  it("落ちた理由を、そのまま出す", () => {
    // **握っていたものを見分けるのは人**である——**飲み込むと、次に落ちたときに
    // 「原因不明」だけが残る**
    const { dir } = withPnpm(["other"]);

    const done = runStart(dir);

    expect(done.stderr, "理由が消えている").toContain("migration failed");
  });
});

describe("CI が、起動と試験を分けている", () => {
  const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");

  /** `database policies` の job だけを切り出す。**別の job の step を拾わない。** */
  function databaseJob(): string {
    const from = workflow.indexOf("  database:");
    expect(from, "database の job が無い").toBeGreaterThanOrEqual(0);
    return workflow.slice(from).split("\n  build:")[0] ?? "";
  }

  function step(name: string): string {
    const job = databaseJob();
    const from = job.indexOf(`- name: ${name}`);
    expect(from, `${name} の step が無い`).toBeGreaterThanOrEqual(0);
    return job.slice(from).split("\n      - ")[0] ?? "";
  }

  it("起動は、やり直す口を通る", () => {
    expect(step("Start Supabase"), "やり直す口を通っていない").toContain("bin/db-start");
  });

  it("試験は、やり直す口を通らない", () => {
    // **ここまでやり直すと、落ちているのに緑になる**（#210 と同じ向き）
    expect(step("Run database policy tests"), "試験までやり直している").not.toContain(
      "bin/db-start",
    );
  });
});
