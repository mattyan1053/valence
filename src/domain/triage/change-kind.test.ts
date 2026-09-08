/**
 * **変更の種類を、パスから決める**（#640）。
 *
 * **「種類」と「危なさ」を混ぜない。** **種類は「何をする PR か」**、
 * **危なさは「壊れたときの影響」**である——**混ぜると、deps を無条件で fast-track する。**
 *
 * **`#625`（Dependabot）が実例**である。**小さくて機械的だったが、CI が落ちて人の手が
 * 要った**（**版が `package.json` と `biome.json` の 2 箇所にあった**）。
 * **仕分けは「読まなくていい」ではなく「どう読むか」を変えるもの**である。
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { changeKindsOf, onlyKindOf, reportableKindOf } from "./change-kind";

describe("パスから、変更の種類を決める", () => {
  it("依存の更新だけの PR を、依存として出す", () => {
    // **#625 がこの形**である（**`package.json` と `pnpm-lock.yaml` だけ**）
    expect(onlyKindOf(["package.json", "pnpm-lock.yaml"])).toBe("deps");
  });

  it("ドキュメントだけの PR を、ドキュメントとして出す", () => {
    expect(onlyKindOf(["README.md", "docs/adr/0001-why.md"])).toBe("docs");
  });

  it("テストだけの PR を、テストとして出す", () => {
    expect(onlyKindOf(["src/domain/triage/risk-tier.test.ts", "test/held-lock.test.ts"])).toBe(
      "test",
    );
  });

  it("生成物だけの PR を、生成物として出す", () => {
    expect(onlyKindOf(["dist/main.js", "src/__generated__/schema.ts"])).toBe("generated");
  });

  it("混ざっていたら、どれか 1 つに丸めない", () => {
    // **混ざった PR がふつうである。** **「docs も触っている」を「docs だけ」に
    // 丸めると、隣の実装が読まれないまま通る。**
    expect(onlyKindOf(["README.md", "src/domain/triage/risk-tier.ts"])).toBeUndefined();
    expect(changeKindsOf(["README.md", "src/domain/triage/risk-tier.ts"])).toEqual(
      new Set(["docs", "other"]),
    );
  });

  it("どれにも当たらないパスを、落とさない", () => {
    // **落とすと、実装だけの PR が「0 種類」になり**、**`onlyKindOf` が
    // 何も無いところから種類を作る。**
    expect(changeKindsOf(["src/app/page.tsx"])).toEqual(new Set(["other"]));
    expect(onlyKindOf(["src/app/page.tsx"])).toBe("other");
  });

  it("1 件も無い PR を、種類のある PR にしない", () => {
    // **`truncated` で 0 件になることがある**（`ChangedPaths`）——**「読めなかった」を
    // 「1 種類だった」に化けさせない。**
    expect(changeKindsOf([])).toEqual(new Set());
    expect(onlyKindOf([])).toBeUndefined();
  });

  describe("1 つのパスが 2 つに当たるときの順番", () => {
    // **順番は 1 箇所で決めてある**（`change-kind.ts`）——**「その変更が何をするか」に
    // 近いほうを先に見る。** **どちらでも通る形にしておくと、変えたことに気づけない。**
    it("ロックファイルは、生成物ではなく依存として見る", () => {
      // **生成されたものではある**が、**読む人にとっては依存が動いたこと**である
      expect(onlyKindOf(["pnpm-lock.yaml"])).toBe("deps");
    });

    it("テストの中の Markdown は、テストではなくドキュメントとして見る", () => {
      // **ファイル名で決まるものを、置き場所より先に見る**
      expect(onlyKindOf(["test/README.md"])).toBe("docs");
    });

    it("生成物の中のテストは、テストではなく生成物として見る", () => {
      // **`dist/` に落ちたものは、直す先がここではない**
      expect(onlyKindOf(["dist/foo.test.js"])).toBe("generated");
    });
  });

  describe("置き場所の名前は、どの階層でも当ててよいわけではない", () => {
    // **このプロダクトは任意のリポジトリを見る**（`AGENTS.md` §1 マルチテナント）
    // ——**`build/` や `docs/` を素の置き場にしているリポジトリは珍しくない。**
    // **「うちではそうだから」で断定すると、違う構成で嘘になる。**
    it("`src/build/` の実装を、生成物にしない", () => {
      expect(onlyKindOf(["src/build/compiler.ts"])).toBe("other");
    });

    it("`src/docs/` の実装を、ドキュメントにしない", () => {
      expect(onlyKindOf(["src/docs/generator.ts"])).toBe("other");
    });

    it("`src/test/` の実装を、テストにしない", () => {
      // **テストの補助かもしれないが、テスト道具の実装かもしれない**
      // ——**言わない側へ倒す。**
      expect(onlyKindOf(["src/test/helpers.ts"])).toBe("other");
    });

    it("先頭の階層なら、そのまま当てる", () => {
      expect(onlyKindOf(["dist/main.js"])).toBe("generated");
      expect(onlyKindOf(["docs/adr/0001-why.txt"])).toBe("docs");
      expect(onlyKindOf(["test/held-lock.ts"])).toBe("test");
    });

    it("その用途にしか使わない名前は、どの階層でも当てる", () => {
      // **`node_modules` / `__generated__` / `__snapshots__` / `__tests__` は、
      // 他の意味で使われない**——**そこだけは深さを問わない。**
      expect(onlyKindOf(["packages/web/node_modules/left-pad/index.js"])).toBe("generated");
      expect(onlyKindOf(["src/api/__generated__/schema.ts"])).toBe("generated");
      expect(onlyKindOf(["src/ui/__snapshots__/view.txt"])).toBe("generated");
      expect(onlyKindOf(["src/ui/__tests__/view.ts"])).toBe("test");
    });
  });

  describe("取りこぼしを、名前で当てない", () => {
    it("`author.ts` を、依存にも生成物にもしない", () => {
      // **`sensitive-path.ts` が語で踏んだのと同じ形**——**部分一致で当てない**
      expect(onlyKindOf(["src/git/author.ts"])).toBe("other");
    });

    it("`contest/` を、テストにしない", () => {
      expect(onlyKindOf(["contest/entry.ts"])).toBe("other");
    });

    it("`distance.ts` を、生成物にしない", () => {
      expect(onlyKindOf(["src/distance.ts"])).toBe("other");
    });
  });
});

describe("画面へ出してよい種類か", () => {
  const seen = (paths: readonly string[]) => ({ paths, truncated: false });

  it("読み方を変えられる種類だけを出す", () => {
    expect(reportableKindOf(seen(["package.json", "pnpm-lock.yaml"]))).toBe("deps");
  });

  it("実装だけの PR には、何も言わない", () => {
    // **盤面のほとんどの行がこれである**——**出すと、読まれない行が 1 つ増えるだけ**
    // （`RiskTierView` が「承認されていない」を出さないのと同じ判断）。
    expect(reportableKindOf(seen(["src/app/page.tsx"]))).toBeUndefined();
  });

  it("混ざっていたら、何も言わない", () => {
    expect(reportableKindOf(seen(["README.md", "src/app/page.tsx"]))).toBeUndefined();
  });

  it("最後まで読めていないなら、何も言わない", () => {
    // **これが `ChangedPaths.truncated` を持っている理由である**（`AGENTS.md` §5）。
    // **見えたぶんが全部 deps でも、見えていないぶんは分からない**
    // ——**「読めなかった」を「deps だけ」に化けさせない。**
    expect(reportableKindOf({ paths: ["package.json"], truncated: true })).toBeUndefined();
  });

  it("1 件も無いなら、何も言わない", () => {
    expect(reportableKindOf(seen([]))).toBeUndefined();
  });
});

/**
 * **このリポジトリに実在するパス**で確かめる（`sensitive-path.test.ts` と同じ形）。
 *
 * **名前が変わったら、当たらなくなったことに気づかず緑のまま**にならないよう、
 * **実在することも一緒に見る。**
 */
describe("このリポジトリ自身のパス", () => {
  const tracked = new Set(
    execFileSync("git", ["ls-files"], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      encoding: "utf8",
    })
      .split("\n")
      .filter((path) => path !== ""),
  );

  const REAL: readonly (readonly [string, string])[] = [
    ["pnpm-lock.yaml", "deps"],
    ["package.json", "deps"],
    ["README.md", "docs"],
    ["src/domain/triage/sensitive-path.test.ts", "test"],
    ["src/domain/triage/sensitive-path.ts", "other"],
  ];

  it.each(REAL)("%s は実在する", (path) => {
    expect(tracked.has(path), `${path} が見つからない（名前が変わった？）`).toBe(true);
  });

  it.each(REAL)("%s は %s として仕分けられる", (path, kind) => {
    expect(onlyKindOf([path])).toBe(kind);
  });
});
