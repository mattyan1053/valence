/**
 * **lint の warning を、溜めないと決める**（#568）。
 *
 * **Biome の warning は `pnpm lint` を落とさない。** **`./task check` も CI も緑**
 * なので、**39 件が誰にも数えられないまま積み上がっていた**——**新しい warning は
 * そこに埋もれる。**
 *
 * **実害が出た（2026-09-02）。** #563 の実装中に `./task check` が赤くなり、
 * **「自分が持ち込んだのか、元からあったのか」を切り分けるために `main` を stash して
 * 同じ検査を打つ**ことになった（**赤の原因は import 順で、warning とは別物**）。
 * **積み上がるほど、次に踏む人の切り分けが長くなる。**
 *
 * ## 数えた結果（`biome check --reporter=json .`）
 *
 * | 種類 | 件数 | 決めたこと |
 * | --- | --- | --- |
 * | `suspicious/noTemplateCurlyInString` | 18 | **試験でだけ外す**（下） |
 * | `correctness/noUnusedImports` | 11 | **消した**（死んだ import） |
 * | `correctness/noUnusedVariables` | 9 | **消した** |
 * | `correctness/noUnusedFunctionParameters` | 1 | **消した** |
 * | `complexity/useIndexOf`（info） | 1 | **直した** |
 * | `deserialize`（info） | 1 | **`$schema` を CLI の版に合わせた** |
 *
 * ## なぜ `noTemplateCurlyInString` を試験でだけ外すか
 *
 * **18 件すべてが、文字列に埋め込んだシェルである**——`"${arg#name=}"` や
 * `"${PIPESTATUS[0]}"` は **bash の展開**で、**バッククォートの書き忘れではない。**
 * **この試験群はシェルスクリプトを本物として起こす**ので、**スタブの本文を
 * 文字列で持つのは避けられない。**
 *
 * **`src/` では外さない。** **製品コードの `"Hello ${name}"` は本物の取り違え**で、
 * **そこはこの規則がいちばん効く場所**である——**外す範囲を広げると、
 * 効かせたい側まで黙る。**
 *
 * ## 溜まらないようにする
 *
 * **`--error-on-warnings` を渡す。** **これが無いと、次の 1 件からまた積み上がる**
 * ——**「誰も見ていない」を「見ないと決めた」にするのが、この Issue である。**
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE = fileURLToPath(new URL("./package.json", import.meta.url));
const BIOME = fileURLToPath(new URL("./biome.json", import.meta.url));

function scripts(): Record<string, string> {
  return JSON.parse(readFileSync(PACKAGE, "utf8")).scripts;
}

/** `package.json` が固定している Biome の版。 */
function pinnedBiome(): string {
  return JSON.parse(readFileSync(PACKAGE, "utf8")).devDependencies["@biomejs/biome"];
}

/** `biome.json` の `$schema` が指している版。 */
function schemaVersion(): string | undefined {
  return JSON.parse(readFileSync(BIOME, "utf8")).$schema?.match(/schemas\/([^/]+)\//)?.[1];
}

type BiomeOverride = {
  readonly includes?: readonly string[];
  readonly linter?: { readonly rules?: Record<string, Record<string, string>> };
};

function overrides(): readonly BiomeOverride[] {
  return JSON.parse(readFileSync(BIOME, "utf8")).overrides ?? [];
}

/** **その規則を外している override**。**無ければ `undefined`。** */
function silencing(rule: string): BiomeOverride | undefined {
  return overrides().find((entry) =>
    Object.values(entry.linter?.rules ?? {}).some((group) => group[rule] === "off"),
  );
}

describe("warning を溜めないと決める", () => {
  it("lint は warning でも落ちる", () => {
    // **これが無いと、次の 1 件からまた積み上がる。**
    // **`./task check` は `pnpm lint` を通る**ので、**ここが唯一の口**である
    expect(scripts().lint).toContain("--error-on-warnings");
  });

  it("check は lint を通る", () => {
    // **上の判定が効く場所を、ここが支えている**——**`check` が `lint` を
    // 呼ばなくなったら、`--error-on-warnings` はどこにも効かない**
    expect(scripts().check).toContain("pnpm lint");
  });
});

describe("設定の版が、入っている版とずれない", () => {
  /**
   * **ずれると Biome が info を出す**（`The configuration schema version does not
   * match the CLI version`）。**info は `--error-on-warnings` では落ちない**ので、
   * **放っておくと、この Issue が消しに来た「誰も見ていない診断」に戻る。**
   *
   * **版は書き写すしかない**（`$schema` は URL である）——**書き写したものは、
   * 上げた側の diff には出てこない**（`AGENTS.md` §5）。**だから、ここで数える。**
   * **deps を上げる PR がこの 1 行を忘れたら、`./task check` が赤くなる。**
   */
  it("$schema は package.json が固定している版を指す", () => {
    expect(schemaVersion()).toBe(pinnedBiome());
  });
});

describe("外すと決めたものには、範囲がある", () => {
  it("シェルを持つ文字列の規則は、試験でだけ外す", () => {
    // **18 件すべてが、文字列に埋め込んだ bash の展開**である
    const entry = silencing("noTemplateCurlyInString");

    expect(entry).toBeDefined();
    expect(entry?.includes).toEqual(["**/*.test.ts"]);
  });

  it("製品コードでは外さない", () => {
    // **`src/` の `"Hello ${name}"` は本物の取り違え**で、**そこが効かせたい場所**
    // ——**範囲が広がった日に、ここが赤くなる**
    const listed = silencing("noTemplateCurlyInString")?.includes ?? [];

    expect(listed.some((glob) => glob === "**" || glob.startsWith("src"))).toBe(false);
  });

  it("外しているのは、この 1 つだけ", () => {
    // **黙らせた規則が増えたら、ここで数え直す**——**「決めた」ものだけを残す**
    const off = overrides().flatMap((entry) =>
      Object.values(entry.linter?.rules ?? {}).flatMap((group) =>
        Object.entries(group)
          .filter(([, level]) => level === "off")
          .map(([rule]) => rule),
      ),
    );

    expect(off).toEqual(["noTemplateCurlyInString"]);
  });
});
