/**
 * **`bin/` の bash を、どこで見るか**（#377 → #395）。
 *
 * **#377 は「CI で見る」と決め、`./task check` には入れなかった**——**理由は
 * 「コンテナに shellcheck が入っておらず、入れるならイメージの作り直しになる」**で、
 * **あの Issue は lint を足す話であって、他の作業場を止める話ではなかった。**
 *
 * **#395 で、その先送りの値段が出た。** **`bin/` を触った変更は push するまで
 * 指摘が出ない**ので、**構造的に 1 往復増える**（**2026-08-22、#392 で実際に踏んだ**
 * ——**手元は緑、CI で SC2028 / SC2034**）。**このループは `bin/` を触る PR が多い。**
 *
 * **決め直した: イメージに入れて、`./task check` の中で見る。** **作り直しの合図は
 * 既にある**（#380 の `bin/image-drift`）ので、**走っている作業場は「古いイメージだ」と
 * 言われて `./task build` を打てる**——**#377 が避けた「黙って赤くなる」ではない。**
 *
 * **CI の job は残す。** **手元で走ることと、CI で必ず走ることは別**である。
 *
 * **一覧は書き写さない**（#377 のまま）。**対象は `bin/lint-shell` が持っている。**
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/** `package.json` の scripts。 */
function scripts(): Record<string, string> {
  const parsed: unknown = JSON.parse(read("package.json"));
  const found =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { scripts?: Record<string, string> }).scripts
      : undefined;
  expect(found, "package.json に scripts が無い").toBeDefined();
  return found ?? {};
}

/**
 * その script を、`pnpm <名前>` を辿って展開する。
 *
 * **名前を書き写さない**ため——**`check` の中身が組み替わっても、辿った先に
 * 口があるかどうかだけを見る。**
 */
function expand(name: string, seen: Set<string> = new Set()): string {
  if (seen.has(name)) {
    return "";
  }
  seen.add(name);
  const body = scripts()[name] ?? "";
  return body.replace(/pnpm (?:run )?([\w:-]+)/g, (whole, called: string) => {
    const inner = expand(called, seen);
    return inner === "" ? whole : `${whole} { ${inner} }`;
  });
}

describe("bash の lint", () => {
  it("check を辿ると、bash の lint の口に着く", () => {
    // **`./task check` は `pnpm check` を打つ**（`task` の `cmd_check`）ので、
    // **そこから辿れる範囲に口が無ければ、手元では永久に見えない。**
    expect(expand("check"), "check から bin/lint-shell へ辿り着けない").toContain("bin/lint-shell");
  });

  it("落ちても先へ進む形にしない", () => {
    // **`|| true` で握りつぶすと、口はあるのに指摘が消える**——**「見ている」と
    // 「止まる」は別**である（#210 の向き）。
    const chain = expand("check");
    const swallowed = chain.slice(chain.indexOf("bin/lint-shell"));
    expect(swallowed, "指摘を握りつぶしている").not.toMatch(/bin\/lint-shell[^&|]*\|\|/);
  });

  it("開発イメージに、その道具が入っている", () => {
    // **道具の名前を書き写さない**——**`bin/lint-shell` が既定として持っている**もの
    // （`${LOOP_SHELLCHECK:-…}`）を読み、**それが入っているか**を見る。
    //
    // **入っていないと、`./task check` は「走らせられない」で赤になる**（#210 の形で
    // 黙って緑にはならない）——**が、それでは誰も check を通せない。**
    const fallback = /LOOP_SHELLCHECK:-([\w.-]+)/.exec(read("bin/lint-shell"));
    expect(fallback?.[1], "既定の道具を読み取れない").toBeDefined();

    expect(read("Dockerfile"), "開発イメージが、その道具を入れていない").toContain(
      fallback?.[1] ?? "",
    );
  });

  it("CI の job は、そのまま残す", () => {
    // **手元で走ることと、CI で必ず走ることは別**である——**手元を飛ばせる経路は
    // いつでもある**（押し直し、別の機械、`./task` を通さない commit）。
    expect(read(".github/workflows/audit.yml"), "CI から bash の lint が消えている").toContain(
      "bin/lint-shell",
    );
  });

  it("CI に一覧を書き写さない", () => {
    // **2 箇所に持つと、片方だけ古くなる**（§5）——**対象は bin/lint-shell が持つ**
    const workflow = read(".github/workflows/audit.yml");

    expect(workflow, "一覧が CI にも書いてある").not.toMatch(/shellcheck .*task docker-entrypoint/);
  });

  it("CI が止める側である", () => {
    // **`|| true` を付けると、指摘が出ても緑になる**——**見ているだけになる**
    const shellJob = read(".github/workflows/audit.yml").split("shell:")[1] ?? "";

    expect(shellJob, "落ちない形で打っている").not.toMatch(/bin\/lint-shell.*\|\|/);
  });
});
