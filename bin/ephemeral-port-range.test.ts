/**
 * **runner の一時ポートが、Supabase の番号へ落ちてこないこと**（#466）。
 *
 * **予約（`ip_local_reserved_ports`）は入っている**が、**打つのは checkout と
 * `pnpm install` のあと**である——**そこまでに張られた接続が 543xx を送信元ポートに
 * 掴むと、あとから予約しても放させられない。** **2026-08-24 の 1 日で 3 回落ちた**
 * （#431 / #453 / #465。**どれも PR の中身と無関係**）。
 *
 * **見るのは「書いてある」ではなく、「効く場所に置いてあるか」**である
 * ——**順序**（checkout より前）と、**値**（設定の番号が範囲の外）。
 *
 * **workflow から取り出して走らせる**（`bin/reserved-ports-guard.test.ts` と同じ形）
 * ——**写すと、直したつもりの側だけが緑になる。**
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const WORKFLOW = fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));
const CONFIG = fileURLToPath(new URL("../supabase/config.toml", import.meta.url));

function workflow(): string {
  return readFileSync(WORKFLOW, "utf8");
}

/**
 * DB の job だけを取り出す。**他の job にも `checkout` はある**ので、
 * **ファイル全体で位置を比べると、いつでも「後ろにある」になる。**
 */
function databaseJob(): string {
  const text = workflow();
  const from = text.indexOf("\n  database:");
  if (from === -1) {
    throw new Error("ci.yml に database の job がありません");
  }
  const rest = text.slice(from + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** workflow が狭める範囲。**写さずに、書いてある値を読む。** */
function narrowedRange(): { low: number; high: number } {
  const found = workflow().match(/net\.ipv4\.ip_local_port_range=(\d+) (\d+)/);
  if (found?.[1] === undefined || found[2] === undefined) {
    throw new Error("ci.yml に一時ポート範囲を狭める行がありません");
  }
  return { low: Number(found[1]), high: Number(found[2]) };
}

/** Supabase が使う番号。**config.toml が正**（CI と同じ引き方）。 */
function supabasePorts(): number[] {
  return [...readFileSync(CONFIG, "utf8").matchAll(/^(?:shadow_)?port = (543\d\d)$/gm)].map(
    (match) => Number(match[1]),
  );
}

/** 狭める側の本体を、workflow から取り出す。**写さない。** */
function narrowScript(): string {
  const lines = workflow().split("\n");
  const from = lines.findIndex((line) => line.includes("net.ipv4.ip_local_port_range="));
  if (from === -1) {
    throw new Error("ci.yml から、狭める手を取り出せません");
  }
  const rest = lines.slice(from);
  const to = rest.findIndex((line, at) => at > 0 && line.trim() !== "" && !/^ {10}/.test(line));
  return rest
    .slice(0, to === -1 ? rest.length : to)
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
}

/**
 * **設定の番号が範囲の外にあることを確かめる**ほうを、workflow から取り出す。
 *
 * **狭める側には番号が書いてある**（checkout より前なので `config.toml` を読めない）
 * ——**設定が動いたら、黙って範囲の中へ戻りうる。** **戻ったら落とす**のがここ。
 */
function crossCheckScript(): string {
  const lines = workflow().split("\n");
  const from = lines.findIndex((line) => line.includes('range_high="$('));
  if (from === -1) {
    throw new Error("ci.yml から、範囲との突き合わせを取り出せません");
  }
  const rest = lines.slice(from);
  const to = rest.findIndex((line) => line === "          fi");
  if (to === -1) {
    throw new Error("突き合わせの終わりが見つかりません");
  }
  return rest
    .slice(0, to + 1)
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
}

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** `sudo` と `sysctl` の身代わり。**読み返しに何を返すかを演じる。** */
function withStubSysctl(readback: string) {
  const dir = mkdtempSync(join(tmpdir(), "ephemeral-range-"));
  made.push(dir);
  writeFileSync(join(dir, "sudo"), '#!/usr/bin/env bash\nexec "$@"\n', { mode: 0o755 });
  writeFileSync(
    join(dir, "sysctl"),
    // **`%b` で書く**——**`\t` を、本物と同じ「タブ 1 文字」として返すため**
    `#!/usr/bin/env bash\nif [ "$1" = "-n" ]; then printf '%b\\n' ${JSON.stringify(readback)}; fi\nexit 0\n`,
    { mode: 0o755 },
  );
  chmodSync(join(dir, "sudo"), 0o755);
  return { PATH: `${dir}:${process.env.PATH ?? ""}` };
}

function runNarrow(readback: string) {
  return spawnSync("bash", ["-c", narrowScript()], {
    encoding: "utf8",
    env: { ...process.env, ...withStubSysctl(readback) },
  });
}

function runCrossCheck(readback: string, ports: { low: number; high: number }) {
  return spawnSync("bash", ["-c", `low=${ports.low}\nhigh=${ports.high}\n${crossCheckScript()}`], {
    encoding: "utf8",
    env: { ...process.env, ...withStubSysctl(readback) },
  });
}

describe("狭めた範囲と、設定の番号を突き合わせる", () => {
  it("設定が範囲の内側なら、そこで落ちる", () => {
    // **狭める側には番号が書いてある** (#466)——**`config.toml` が動けば、黙って
    // 範囲の中へ戻る。** **症状は同じ bind 失敗**で、**原因は見えない。**
    const failed = runCrossCheck("32768\t60999", { low: 54320, high: 54329 });

    expect(failed.status, "範囲の内側なのに通している").not.toBe(0);
    expect(`${failed.stdout}${failed.stderr}`, "どちらを直せばよいかが出ていない").toMatch(
      /Keep ephemeral ports away from Supabase/,
    );
  });

  it("外側なら、通る", () => {
    const passed = runCrossCheck("32768\t54319", { low: 54320, high: 54329 });

    expect(passed.status, `外側なのに落ちている: ${passed.stderr}`).toBe(0);
  });
});

describe("一時ポートを、Supabase の番号から遠ざける", () => {
  it("狭めるのは、checkout より前", () => {
    // **`pnpm install` は数百本の接続を張る** (#466)——**そのあとで予約しても、
    // 既に掴んでいる者は放さない。** **効くのは、接続が張られる前だけ**である。
    const text = databaseJob();
    const at = text.indexOf("net.ipv4.ip_local_port_range=");

    // **無いものは -1 になる**——**そのままだと、書いていないのに「前にある」で通る**
    expect(at, "狭める手が無い").toBeGreaterThanOrEqual(0);
    expect(at, "狭める手が、checkout より後ろにある").toBeLessThan(
      text.indexOf("actions/checkout"),
    );
  });

  it("狭めた範囲に、Supabase の番号が入っていない", () => {
    // **これが効き目そのもの**である——**範囲の中にあれば、割り当てられる。**
    // **番号は config.toml が正**（**CI と同じ引き方で読む**）。
    const { low, high } = narrowedRange();
    const ports = supabasePorts();

    expect(ports.length, "config.toml から番号を読めていない").toBeGreaterThan(0);
    expect(
      ports.filter((port) => port >= low && port <= high),
      "狭めた範囲の中に、Supabase の番号がある",
    ).toEqual([]);
  });

  it("狭められなければ、そこで落ちる", () => {
    // **入れた対策が働いているかを、対策自身が確かめる**（#432 と同じ形）
    // ——**効かないまま進むと、同じ bind 失敗が「原因不明」として返る。**
    const failed = runNarrow("32768\t60999");

    expect(failed.status, "狭められていないのに、そのまま進んでいる").not.toBe(0);
    expect(`${failed.stdout}${failed.stderr}`, "何が起きたのかが出ていない").toMatch(/一時ポート/);
  });

  it("狭められたなら、通る", () => {
    const { low, high } = narrowedRange();

    const passed = runNarrow(`${low}\t${high}`);

    expect(passed.status, `狭まっているのに落ちている: ${passed.stderr}`).toBe(0);
  });
});
