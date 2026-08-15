import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type Example, readExamples } from "../loop/fixup-limit-record";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * 記録した実例を、本当に測り直して突き合わせる側。
 *
 * **列が揃っていることと、値が本当であることは別**である（#309 のレビュー）——
 * **`70` を `700` に書き換えても、SHA を別の 40 桁へ差し替えても、形を見る側は通る。**
 *
 * **本物を測るには網が要る**（`bin/loop-fixup-lines` は GitHub のレビュースレッドと
 * `compare` を叩く）ので、**`./task check` には入れない**——**`*.db.test.ts` を
 * 外したのと同じ理由**である（#210。**起きていないだけで赤になる**）。
 * **赤くする場所は CI の専用 job** で、**ここで見るのは「突き合わせの側が働くか」**である。
 *
 * **測る側は偽物にするが、記録は本物を置く。** **写しを作ると、写しだけを見て緑になる。**
 */
function run(options: { lying?: string; failing?: string; record?: string } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), "fixup-basis-"));
  try {
    mkdirSync(join(workspace, "bin"), { recursive: true });
    for (const name of ["loop-fixup-basis", "loop-gate"]) {
      writeFileSync(
        join(workspace, "bin", name),
        readFileSync(join(REPO_ROOT, "bin", name), "utf8"),
        { mode: 0o755 },
      );
    }
    if (options.record !== undefined) {
      const gate = readFileSync(join(workspace, "bin/loop-gate"), "utf8");
      writeFileSync(
        join(workspace, "bin/loop-gate"),
        gate.replace(/^# {3}\d+\t.*$/gm, options.record),
        { mode: 0o755 },
      );
    }

    const cases = readExamples(readFileSync(join(workspace, "bin/loop-gate"), "utf8"))
      .map((example) => {
        const measured =
          options.lying === example.pr
            ? [String(Number(example.measured[0]) + 1), example.measured[1], example.measured[2]]
            : example.measured;
        // **落ちる側も、記録どおりの値を出してから落ちる。** **値が違えば食い違いの側で
        // 捕まる**ので、**それだと「落ちたことを見ている」試験にならない**
        const fail = options.failing === example.pr ? " exit 1;" : "";
        return `  ${example.pr}) printf '%s\\t%s\\t%s\\n' ${measured.join(" ")};${fail} ;;`;
      })
      .join("\n");
    writeFileSync(
      join(workspace, "bin/loop-fixup-lines"),
      ["#!/usr/bin/env bash", "case $1 in", cases, "  *) exit 1 ;;", "esac", ""].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync(join(workspace, "bin/loop-fixup-basis"), [], {
      cwd: workspace,
      encoding: "utf8",
    });
    return { ...result, status: result.status ?? -1 };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function first(): Example {
  const [example] = readExamples(readFileSync(join(REPO_ROOT, "bin/loop-gate"), "utf8"));
  if (example === undefined) {
    throw new Error("実例が 1 件も記録されていない");
  }
  return example;
}

describe("記録した実例を、測り直して突き合わせる", () => {
  it("記録どおりなら、全行を照合して通る", () => {
    const result = run();

    expect(result.status, `照合が走らない: ${result.stderr}`).toBe(0);
    // **1 行目だけ見て終わらない**（**残りが食い違っていても緑になる**）
    for (const example of readExamples(readFileSync(join(REPO_ROOT, "bin/loop-gate"), "utf8"))) {
      expect(result.stdout, `#${example.pr} を照合していない`).toContain(example.pr);
    }
  });

  it("記録と測り直しが食い違ったら、落ちる", () => {
    // **これが無いと、照合は「走った」だけで何も見ていない**——
    // **`70` を `700` に書き換えても通る**、が #309 の指摘そのものである
    const result = run({ lying: first().pr });

    expect(result.status, "食い違っているのに通っている").not.toBe(0);
    expect(result.stderr, "どの記録が食い違うのかが出ない").toContain(first().pr);
  });

  it("測り直せなかったら、「一致」にしない", () => {
    // **落ちたのを黙って飛ばすと、測れなかった行が照合済みになる**——
    // **測り直しの手順が「欠けたまま表を出さない」としたのと同じ形**である
    const result = run({ failing: first().pr });

    expect(result.status, "測れなかったのに通っている").not.toBe(0);
  });

  it("記録が 1 行も無ければ、照合できたことにしない", () => {
    // **空の記録は「全部一致した」に化ける**——**`for` は 0 回まわって成功する。**
    // **記録の書式を変えて、読めなくなった日**がこの経路である
    const result = run({ record: "# （記録が消えている）" });

    expect(result.status, "記録が無いのに通っている").not.toBe(0);
    expect(result.stderr, "記録が読めなかったことが出ない").toMatch(/記録/);
  });

  it("列が足りない記録は、測らずに落ちる", () => {
    // **`read` は足りない変数を空にするだけ**なので、**列を落とした記録は
    // 「空の SHA で測る」へ倒れる**——**測る側が何を返しても、それは照合ではない**
    const result = run({ record: "#   224\t70\t295\t60" });

    expect(result.status, "列が足りないのに通っている").not.toBe(0);
    expect(result.stderr, "何が足りないのかが出ない").toMatch(/列|記録/);
  });
});
