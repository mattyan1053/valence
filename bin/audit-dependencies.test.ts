/**
 * **「脆弱性が見つかった」と「registry へ届かなかった」を言い分ける**（#612）。
 *
 * **実測**（2026-08-26 以降の `Audit` の run **200 件中 failure は 2 件**。
 * **11 分の中に収まっており、1 回の障害である**）——**落ちること自体は稀**だが、
 * **落ちた理由がログを読むまで分からない**ので、**master が手で `gh run rerun` を打った。**
 *
 * **`--ignore-registry-errors` を素で使わない**——**registry が落ちている間、
 * 監査が走っていないのに緑になる**（**「落ちたら無視する」で通すと監査が消える**）。
 * **この口は「見分けるため」にだけ使い、届かなかったぶんは改めて止める。**
 *
 * **見分けは構造で行う**（**文言では見ない**）——**報告は
 * `metadata.totalDependencies` を持つ**。**届かなかったときの出力は報告ではない。**
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./audit-dependencies", import.meta.url));

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

/** 偽の `pnpm`。**その 3 通りだけを返す。** */
function withPnpm(stdout: string, status: number): string {
  const dir = mkdtempSync(join(tmpdir(), "audit-deps-"));
  sandboxes.push(dir);
  mkdirSync(join(dir, "bin"), { recursive: true });
  const stub = join(dir, "bin", "pnpm");
  writeFileSync(stub, `#!/usr/bin/env bash\ncat <<'JSON'\n${stdout}\nJSON\nexit ${status}\n`);
  chmodSync(stub, 0o755);
  return join(dir, "bin");
}

const REPORT = JSON.stringify({
  advisories: {},
  metadata: { vulnerabilities: { moderate: 0 }, totalDependencies: 248 },
});

function run(stubBin: string) {
  return spawnSync(SCRIPT, [], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${stubBin}:${process.env.PATH}` },
  });
}

describe("依存の脆弱性を見る", () => {
  it("見つからなければ、通す", () => {
    const done = run(withPnpm(REPORT, 0));

    expect(done.status, `止まっている: ${done.stderr}`).toBe(0);
  });

  it("見つかったら、止める", () => {
    const found = JSON.stringify({
      advisories: { "1": { severity: "moderate" } },
      metadata: { vulnerabilities: { moderate: 1 }, totalDependencies: 248 },
    });

    const done = run(withPnpm(found, 1));

    expect(done.status, "見つかったのに通している").not.toBe(0);
    expect(done.stderr, "何が見つかったか言っていない").toContain("脆弱性");
  });

  it("段より下の脆弱性しか無ければ、数え直さずに通す", () => {
    // **段の判定は `pnpm` が持つ**（#616 のレビュー）——**`--json` でも効いている。**
    // **実物で確かめた**（`pnpm@11.20.0`、moderate が 1 件だけの木）:
    //
    //   --audit-level moderate  exit=1  advisories=1
    //   --audit-level high      exit=0  advisories=0  metadata={"moderate":1,"critical":1}
    //
    // **`metadata.vulnerabilities` は段で絞られない**——**そこを数えると、
    // 段より下の 1 件で全 PR が止まる。** **数えるのは終了コードだけである。**
    const belowLevel = JSON.stringify({
      advisories: {},
      metadata: { vulnerabilities: { low: 3, moderate: 0 }, totalDependencies: 248 },
    });

    const done = run(withPnpm(belowLevel, 0));

    expect(done.status, "段より下を数えて止めている").toBe(0);
  });

  it("JSON でも、報告の形でなければ止める", () => {
    // **`fetch failed` は JSON ですらない**ので、**`JSON.parse` が先に投げる**
    // ——**`metadata.totalDependencies` を見る判定は、それだけでは 1 度も通らない**
    // （**変異を打って気づいた。緑のままだった**）。
    //
    // **報告の形を要求するのは、黙って緑にしないため**である——**中身が変わっても
    // 「監査が走った」と読める形かどうかは、ここでしか見ていない。**
    const done = run(withPnpm("{}", 0));

    expect(done.status, "報告でないのに通している").not.toBe(0);
    expect(done.stderr, "届かなかったと言っていない").toContain("registry");
  });

  it("registry へ届かなければ、止めて、そう言う", () => {
    // **`--ignore-registry-errors` は exit 0 を返す**（実測）——**そのまま通すと、
    // 監査が走っていないのに緑になる。** **報告でないことを見て、改めて止める。**
    const done = run(withPnpm("fetch failed", 0));

    expect(done.status, "監査が走っていないのに通している").not.toBe(0);
    expect(done.stderr, "届かなかったと言っていない").toContain("registry");
    expect(done.stderr, "脆弱性と読めてしまう").not.toContain("脆弱性が見つかりました");
  });
});
