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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

/**
 * 偽の `pnpm`。**その 3 通りだけを返し、渡された引数を書き残す。**
 *
 * **引数を見ないと、渡していることを誰も確かめていない**（#616 のレビュー 2 周目）
 * ——**`--audit-level` を落として既定（`low`）へ戻しても**、**`--json` を落として
 * 正常な監査まで registry 障害扱いにしても**、**この試験は緑のままだった。**
 */
function withPnpm(
  stdout: string,
  status: number,
): { bin: string; args: () => string; words: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), "audit-deps-"));
  sandboxes.push(dir);
  mkdirSync(join(dir, "bin"), { recursive: true });
  const argsLog = join(dir, "args");
  // **偽の `timeout`**（#620 のレビュー 2 周目）。**引数を書き残し、
  // `TIMEOUT_EXIT` があればその値で返す**——**壁時計を待たずに測るため。**
  const clock = join(dir, "bin", "timeout");
  writeFileSync(
    clock,
    `#!/usr/bin/env bash\nprintf 'timeout %s\\n' "$*" >>${JSON.stringify(argsLog)}\n` +
      // **打ち切られても、途中までの出力は出ている**——**報告として読めるまま
      // 124 で終わる形**を作る。**走らせずに返すと、出力が空になり「形が違う」側で
      // 落ちる**ので、**124 の分岐に届かない**（変異が緑のままだった）。
      `shift\n"$@"\ncode=$?\n[[ -z \${TIMEOUT_EXIT:-} ]] || exit "$TIMEOUT_EXIT"\nexit "$code"\n`,
  );
  chmodSync(clock, 0o755);
  const stub = join(dir, "bin", "pnpm");
  writeFileSync(
    stub,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >>${JSON.stringify(argsLog)}\ncat <<'JSON'\n${stdout}\nJSON\nexit ${status}\n`,
  );
  chmodSync(stub, 0o755);
  return {
    bin: join(dir, "bin"),
    args: () => (existsSync(argsLog) ? readFileSync(argsLog, "utf8") : ""),
    /**
     * **語に割ったもの**（#620 のレビュー）。**`toContain` は途中一致**なので、
     * **`--config.fetch-retries=1` は `=10` や `=100` でも通る**
     * ——**上限が崩れても気づけない。**
     */
    words: () => (existsSync(argsLog) ? readFileSync(argsLog, "utf8").split(/\s+/) : []),
  };
}

const REPORT = JSON.stringify({
  advisories: {},
  metadata: { vulnerabilities: { moderate: 0 }, totalDependencies: 248 },
});

function run(pnpm: { bin: string }, env: Record<string, string> = {}) {
  return spawnSync(SCRIPT, [], {
    encoding: "utf8",
    env: { ...process.env, ...env, PATH: `${pnpm.bin}:${process.env.PATH}` },
  });
}

describe("依存の脆弱性を見る", () => {
  it("見つからなければ、通す", () => {
    const done = run(withPnpm(REPORT, 0));

    expect(done.status, `止まっている: ${done.stderr}`).toBe(0);
  });

  it("段を渡している", () => {
    // **「段の判定は `pnpm` が持つ」は、渡していることが前提**である（#616 のレビュー）
    // ——**落とすと既定（`low`）へ戻り**、**low の 1 件で必須チェックが落ちる。**
    const pnpm = withPnpm(REPORT, 0);

    run(pnpm);

    expect(pnpm.words(), "段を渡していない").toContain("--audit-level");
    expect(pnpm.words(), "段を渡していない").toContain("moderate");
  });

  it("報告の形で受け取っている", () => {
    // **「報告かどうかで見分ける」は、`--json` を渡していることが前提**である
    // ——**落とすと表形式が返り**、**正常な監査まで registry 障害として止まる。**
    const pnpm = withPnpm(REPORT, 0);

    run(pnpm);

    expect(pnpm.words(), "報告で受け取っていない").toContain("--json");
  });

  it("試行の回数は、既定のままにする", () => {
    // **時間の上限は `timeout` が持っている**（#620 のレビュー）ので、
    // **回数を絞る理由は消えた。** **絞ると、瞬きのような障害で落ちやすくなる**
    // ——**実測: `retries=1` を入れた枝だけが 3 回連続で落ち**、
    // **同じ時間帯に既定の枝は通っていた**（`main` 07:01 / #618 06:55 / #583 08:12）。
    //
    // **既定（2 回）でも壁時計は破れない**——**60 ＋ 10 ＋ 60 ＋ 60 で 180 秒に届き**、
    // **そこで `timeout` が切って `exit 2` を出す。** **回数は渡さない。**
    const pnpm = withPnpm(REPORT, 0);

    run(pnpm);

    expect(pnpm.words(), "回数を渡している（既定に任せる）").not.toContain(
      "--config.fetch-retries=1",
    );
  });

  it("壁時計で打ち切っている", () => {
    // **`fetch-retries` は回数の上限で、壁時計の上限ではない**（#620 のレビュー）
    // ——**registry がヘッダーだけ返して本文を止めれば、1 回の試行が何分でも続く。**
    // **`fetch-timeout` もコマンド全体の上限ではない。**
    //
    // **上限は測って決めた**——**正常時でも 74〜133 秒**（**3 回中 2 回は再試行を
    // 1 度挟む**）、**切られた周回で監査に与えられていたのは 198 秒。**
    const pnpm = withPnpm(REPORT, 0);

    run(pnpm);

    expect(pnpm.words(), "壁時計で打ち切っていない").toContain("timeout");
    expect(pnpm.words(), "上限を渡していない").toContain("180");
  });

  it("打ち切られたら、脆弱性と混ぜずに止める", () => {
    // **`timeout` は打ち切ったとき 124 を返す**——**「脆弱性が見つかった」と
    // 同じ顔にしない。** **判定できなかったぶんは registry の側である。**
    const pnpm = withPnpm(REPORT, 0);

    const done = run(pnpm, { TIMEOUT_EXIT: "124" });

    expect(done.status, "打ち切られたのに通している").toBe(2);
    expect(done.stderr, "届かなかったと言っていない").toContain("registry");
    expect(done.stderr, "脆弱性と読めてしまう").not.toContain("脆弱性が見つかりました");
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
