/**
 * レイヤ間の依存方向を機械的に強制する。
 *
 * 依存の矢印は常に内向き (app → composition → application → domain)。
 * ルールを緩めて通すのではなく、設計を直すこと。
 * どうしても例外が必要なら、なぜ必要かをコメントに書いてから追加する。
 *
 * 詳細は AGENTS.md §4 を参照。
 */

/**
 * テストは対象レイヤの内側に置く (co-location) が、レイヤ規則の対象外にする。
 * vitest やテストダブルを import できないと、そもそもテストが書けないため。
 */
const TEST_FILE = "\\.test\\.tsx?$";

export default {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "循環依存は責務の切り方を間違えているサイン。どちらかを内側へ寄せて解消する。",
      from: {},
      to: { circular: true },
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      comment: "解決できない import。パスの打ち間違いか、依存の入れ忘れ。",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-orphans",
      severity: "warn",
      comment: "どこからも参照されていないモジュール。消し忘れでなければ配線を確認する。",
      from: {
        orphan: true,
        pathNot: [
          "\\.d\\.ts$",
          "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$",
          "(^|/)tsconfig\\.json$",
          // App Router の規約ファイルは Next 側から読まれるため参照元が現れない
          "^src/app/.+/(page|layout|template|loading|error|not-found|route)\\.tsx?$",
          "^src/app/(page|layout|template|loading|error|not-found|route|global-error)\\.tsx?$",
        ],
      },
      to: {},
    },

    // ------------------------------------------------------------ レイヤ境界

    {
      name: "domain-is-pure",
      severity: "error",
      comment:
        "domain はビジネスルールそのもの。Node 標準以外の一切に依存させない " +
        "(npm パッケージも他レイヤも不可)。これが守れていれば domain は " +
        "フレームワークを起動せずにテストできる。",
      from: { path: "^src/domain/", pathNot: TEST_FILE },
      to: {
        pathNot: "^src/domain/",
        dependencyTypesNot: ["core"],
      },
    },
    {
      name: "application-depends-on-domain-only",
      severity: "error",
      comment:
        "application は port (interface) を定義するだけで、その実装を知らない。" +
        "他レイヤはもちろん npm パッケージも禁止する。Octokit や Supabase の " +
        "SDK をここで掴むと、それは infrastructure がユースケースに漏れている状態。" +
        "触りたくなったら port の設計漏れなので、interface を切り直すこと。",
      from: { path: "^src/application/", pathNot: TEST_FILE },
      to: {
        pathNot: "^src/(application|domain)/",
        dependencyTypesNot: ["core"],
      },
    },
    {
      name: "infrastructure-does-not-reach-out",
      severity: "error",
      comment: "infrastructure は port の実装。外側 (ui/app/composition) を知る必要はない。",
      from: { path: "^src/infrastructure/", pathNot: TEST_FILE },
      to: { path: "^src/(ui|app|composition)/" },
    },
    {
      name: "ui-has-no-io",
      severity: "error",
      comment:
        "ui は表示に専念する。データ取得や副作用を持ち込まない。" +
        "必要な値は props で受け取り、取得は app/composition 側で行う。",
      from: { path: "^src/ui/", pathNot: TEST_FILE },
      to: { path: "^src/(application|infrastructure|composition)/" },
    },
    {
      name: "adapters-are-wired-only-in-composition",
      severity: "error",
      comment:
        "実装の差し替え点を composition に集約する。app から infrastructure を " +
        "直接 import すると、テスト時に差し替えられなくなる。",
      from: { path: "^src/app/", pathNot: TEST_FILE },
      to: { path: "^src/infrastructure/" },
    },

    // ------------------------------------------------------------ 依存の種類

    {
      name: "no-dev-dep-in-src",
      severity: "error",
      comment: "本番コードから devDependencies を参照しない。ビルドが壊れる。",
      from: { path: "^src/", pathNot: TEST_FILE },
      to: { dependencyTypes: ["npm-dev"], dependencyTypesNot: ["type-only"] },
    },
    {
      name: "no-deprecated-npm",
      severity: "warn",
      comment: "非推奨になった npm パッケージ。代替を探す。",
      from: {},
      to: { dependencyTypes: ["deprecated"] },
    },
  ],

  options: {
    doNotFollow: { path: "node_modules" },
    // 型のみの import も依存として数える。型だけならレイヤを跨いでよい、とはしない。
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
