/**
 * 変更されたパスから「何をする PR か」を決める（#640）。
 *
 * ここは純粋関数で、GitHub のレスポンス型ではなくパスの文字列だけを受け取る
 * （`sensitive-path.ts` と同じ形）。
 *
 * ## 「種類」と「危なさ」を混ぜない
 *
 * **種類は「何をする PR か」**、**危なさは「壊れたときの影響」**である。
 * **混ぜると、deps を無条件で fast-track する**——**`classifyRiskTier` はここを見ない。**
 *
 * **`#625`（Dependabot）が実例**である。**`package.json` と `pnpm-lock.yaml` だけの
 * 機械的な変更**だったが、**版が `biome.json` にもあり、そちらがずれて CI が落ちた**
 * ——**人の手が要った。** **「deps だから読まなくていい」ではない**ので、
 * **仕分けは「どう読むか」を変えるもの**として使う。
 *
 * ## どれにも当たらないものを落とさない
 *
 * **混ざった PR がふつうである。** **当たらなかったパスを黙って捨てると、
 * `README.md` と実装を触った PR が「ドキュメントだけ」に見える**
 * ——**隣の実装が読まれないまま通る。** **だから `other` を種類として持つ。**
 *
 * ## 一覧は必ず不完全である
 *
 * **マルチテナントである**（`AGENTS.md` §1）——**対象リポジトリは 1 つではない**ので、
 * **どの言語・どの道具でも当てられる一覧は書けない。**
 *
 * **倒れる向きは `other` である**（`sensitive-path.ts` が「拾いすぎ側」へ倒すのとは逆）。
 * **取りこぼすと `other` が混ざり、`onlyKindOf` は何も言わなくなる**
 * ——**「読み方を変える材料が出ない」だけ**である。**誤って「deps だけ」と言うと、
 * 読まれずに通る**ので、**言わない側へ倒す。**
 *
 * **リポジトリごとの設定は作らない**（`sensitive-path.ts` と同じ。MVP のスコープ外）。
 * **規則は定数として 1 箇所に出してある**ので、設定にしたくなったらここを差し替える。
 */

import type { ChangedPaths } from "./risk-tier";
import { DEPENDENCY_PIN_FILE_NAMES, DEPENDENCY_PIN_SUFFIXES } from "./sensitive-path";

/**
 * その変更が何をするか。
 *
 * **`other` を必ず持つ。** **「どれにも当たらない」は結果であって、欠落ではない。**
 */
export type ChangeKind = "deps" | "docs" | "test" | "generated" | "other";

/**
 * 依存の宣言。**固定（ロックファイル）は `sensitive-path.ts` が持っている一覧を読む**
 * ——**同じ一覧を 2 箇所に置かない**（`AGENTS.md` §5）。
 *
 * **宣言のほうはここにしかない。** **`package.json` は依存だけを持つわけではない**
 * （スクリプトも設定も入る）が、**そこが動いたことは「依存が動いた」と同じくらい
 * 読み方を変える**ので、**依存として扱う。**
 */
const DEPENDENCY_MANIFEST_FILE_NAMES: readonly string[] = [
  "package.json",
  "go.mod",
  "cargo.toml",
  "pyproject.toml",
  "pipfile",
  "gemfile",
  "composer.json",
  "build.gradle",
  "pom.xml",
];

/** テストだと、ファイル名だけで分かるもの（`foo.test.ts` / `foo_test.go` / `foo.spec.rb`）。 */
const TEST_FILE_INFIXES: readonly string[] = [".test.", ".spec.", "_test.", "_spec."];

/**
 * 置き場所の名前は、**どの階層でも当ててよいものと、先頭でだけ当てるもの**に分ける。
 *
 * **このプロダクトは任意のリポジトリを見る**（`AGENTS.md` §1 マルチテナント）。
 * **`build/` や `docs/` を素の置き場にしているリポジトリは珍しくない**ので、
 * **どの階層でも当てると `src/build/compiler.ts` が「生成物だけです」になる**
 * ——**実装を読まずに通す方向へ、事実でない理由で押す。**
 *
 * **分ける基準は「他の意味で使われるか」**である。**`node_modules` や `__x__` は
 * その用途にしか使わない**ので深さを問わない。**それ以外は、先頭の階層でだけ当てる。**
 *
 * **単発の名前を潰さない**（#647 のレビュー）——**`build` だけ直すと、
 * 次は `docs` で同じことが起きる。** **どこで当てるかを、名前ごとに 1 回決める。**
 *
 * **取りこぼす向きに倒れる。** **monorepo の `packages/web/dist/` は当たらない**が、
 * **当たらなければ `other` になり、画面は何も言わない**——**誤って言い切るより軽い。**
 */
type DirectoryRule = {
  /** どの階層に現れても、その種類だと言い切れる名前。 */
  readonly anywhere: readonly string[];
  /** 先頭の階層にあるときだけ当てる名前。**他の意味でも使われる。** */
  readonly topLevel: readonly string[];
};

/** テストの置き場所。**語として一致したときだけ当てる**（`contest/` を拾わない）。 */
const TEST_DIRECTORIES: DirectoryRule = {
  anywhere: ["__tests__"],
  topLevel: ["test", "tests", "spec", "specs", "e2e"],
};

/** ドキュメントだと、拡張子だけで分かるもの。 */
const DOCUMENT_EXTENSIONS: readonly string[] = [".md", ".mdx", ".rst", ".adoc", ".textile"];

/** 決まった名前のドキュメント。**拡張子は持たないか、下のものだけ。** */
const DOCUMENT_FILE_NAMES: readonly string[] = ["license", "notice", "authors", "changelog"];

/**
 * 固定名に付いてよい拡張子 (#647 のレビュー 3 周目)。
 *
 * **任意の拡張子を落として比べない。** **`src/billing/license.ts` は実装**であり、
 * **「文書だけです」と出すと、まさに読ませたい変更を読まずに通す。**
 *
 * **`.md` や `.rst` はここに要らない**——**`DOCUMENT_EXTENSIONS` が先に拾う。**
 * **`LICENSE.txt` を拾うために置いてある**（**`.txt` は文書とは限らないので、
 * 固定名と組んだときだけ**）。
 */
const DOCUMENT_PLAIN_EXTENSIONS: readonly string[] = [".txt"];

/** 決まった名前のドキュメントか。**拡張子は「無い」か「許したもの」だけ。** */
function isNamedDocument(fileName: string): boolean {
  return (
    DOCUMENT_FILE_NAMES.includes(fileName) ||
    DOCUMENT_PLAIN_EXTENSIONS.some(
      (extension) =>
        fileName.endsWith(extension) &&
        DOCUMENT_FILE_NAMES.includes(fileName.slice(0, -extension.length)),
    )
  );
}

/** ドキュメントの置き場所。**`docs/` を素の置き場にしているリポジトリがある。** */
const DOCUMENT_DIRECTORIES: DirectoryRule = { anywhere: [], topLevel: ["docs", "doc"] };

/** 生成物だと、ファイル名だけで分かるもの。 */
const GENERATED_FILE_INFIXES: readonly string[] = [".generated.", ".gen.", ".min.", ".pb."];

/** 生成物だと、拡張子だけで分かるもの（`__snapshots__/foo.snap` / `bundle.js.map`）。 */
const GENERATED_EXTENSIONS: readonly string[] = [".snap", ".map"];

/** 生成物の置き場所。**語として一致したときだけ当てる**（`distance.ts` を拾わない）。 */
const GENERATED_DIRECTORIES: DirectoryRule = {
  // **その用途にしか使わない名前**——**深さを問わない**
  anywhere: ["node_modules", "__generated__", "__snapshots__"],
  // **素の置き場にもなる名前**——**`src/build/compiler.ts` を生成物にしない**
  topLevel: ["dist", "build", "generated", "vendor"],
};

/** その置き場所に入っているか。**どこで当てるかは `DirectoryRule` が決める。** */
function inDirectory(segments: readonly string[], rule: DirectoryRule): boolean {
  const [top] = segments;
  return (
    rule.anywhere.some((name) => segments.includes(name)) ||
    (top !== undefined && rule.topLevel.includes(top))
  );
}

/**
 * 1 つのパスの種類。
 *
 * **順番はここ 1 箇所で決める。** **「その変更が何をするか」に近いほうを先に見る**
 * ——**ロックファイルは生成物でもあるが、読む人にとっては依存が動いたこと**である。
 *
 * **ファイル名で決まるものを、置き場所より先に見る**——**`test/README.md` は
 * テストではなくドキュメント**である（**直す理由が違う**）。**ただし生成物の中は例外**で、
 * **`dist/foo.test.js` の直す先はそこではない**ので、置き場所のほうが勝つ。
 */
function kindOf(path: string): ChangeKind {
  const normalized = path.replace(/^\.\//, "").toLowerCase();
  const segments = normalized.split("/");
  const fileName = segments.pop() ?? "";

  // **生成物の置き場所だけ、いちばん先に見る**（上記の例外）
  if (inDirectory(segments, GENERATED_DIRECTORIES)) {
    return "generated";
  }
  if (
    DEPENDENCY_PIN_FILE_NAMES.includes(fileName) ||
    DEPENDENCY_PIN_SUFFIXES.some((suffix) => fileName.endsWith(suffix)) ||
    DEPENDENCY_MANIFEST_FILE_NAMES.includes(fileName)
  ) {
    return "deps";
  }
  if (DOCUMENT_EXTENSIONS.some((extension) => fileName.endsWith(extension))) {
    return "docs";
  }
  if (isNamedDocument(fileName)) {
    return "docs";
  }
  if (TEST_FILE_INFIXES.some((infix) => fileName.includes(infix))) {
    return "test";
  }
  if (
    GENERATED_FILE_INFIXES.some((infix) => fileName.includes(infix)) ||
    GENERATED_EXTENSIONS.some((extension) => fileName.endsWith(extension))
  ) {
    return "generated";
  }
  if (inDirectory(segments, TEST_DIRECTORIES)) {
    return "test";
  }
  if (inDirectory(segments, DOCUMENT_DIRECTORIES)) {
    return "docs";
  }
  return "other";
}

/**
 * その PR が触ったものの種類。**混ざっていれば複数入る。**
 *
 * **1 件も無ければ空である**——**`truncated` で 0 件になることがある**ので、
 * **「読めなかった」を「1 種類だった」に化けさせない。**
 */
export function changeKindsOf(changedPaths: readonly string[]): ReadonlySet<ChangeKind> {
  return new Set(changedPaths.map(kindOf));
}

/**
 * **全部が同じ種類なら、その種類。** 混ざっていれば `undefined`。
 *
 * **読み方を変えられるのは「〜だけ」のとき**である——**1 つでも別のものが混ざれば、
 * そちらを読むことになる**ので、**言うことは無い。**
 */
export function onlyKindOf(changedPaths: readonly string[]): ChangeKind | undefined {
  const kinds = changeKindsOf(changedPaths);
  const [only] = kinds;
  return kinds.size === 1 ? only : undefined;
}

/**
 * **読み方を変えられる種類**（`other` は入らない）。
 *
 * **`other` を出さない**のは、**盤面のほとんどの行がそれだから**である
 * ——**出しても、読まれない行が 1 つ増えるだけ**（`ApprovalBadge` が
 * 「承認されていない」を出さないのと同じ判断）。
 */
export type ReportableChangeKind = Exclude<ChangeKind, "other">;

/**
 * 画面へ出してよい種類。**言えないときは `undefined`。**
 *
 * **最後まで読めていないなら、何も言わない。** **見えたぶんが全部 deps でも、
 * 見えていないぶんは分からない**——**「読めなかった」を「deps だけ」に化けさせない**
 * （`AGENTS.md` §5。**`ChangedPaths` が `truncated` を持っているのはこのため**）。
 *
 * **「言ってよいか」をここ 1 箇所に置く**（§5）——**画面側に散らすと、
 * 出す場所が増えたときに片方だけが truncated を見る。**
 */
export function reportableKindOf(changedPaths: ChangedPaths): ReportableChangeKind | undefined {
  if (changedPaths.truncated) {
    return undefined;
  }
  const only = onlyKindOf(changedPaths.paths);
  return only === undefined || only === "other" ? undefined : only;
}
