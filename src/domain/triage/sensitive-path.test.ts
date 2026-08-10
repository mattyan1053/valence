import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { touchesSensitivePath } from "./sensitive-path";

/**
 * **このリポジトリに実在するパス**で確かめる回帰試験。
 *
 * `src/infrastructure/github/app-jwt.ts` を取りこぼしていた（#114 のレビュー）。
 * **自分自身のリポジトリで踏む形**だったので、**実物のパスで固定する**。
 * ファイルが消えたり名前が変わったりしたら、この試験は**存在しない**ほうで落ちる
 * （当たらなくなったことに気づかず緑のまま、を避ける）。
 */
const REAL_SENSITIVE_PATHS: readonly string[] = [
  "src/infrastructure/github/app-jwt.ts",
  "src/infrastructure/github/app-credentials.ts",
  "src/infrastructure/github/installation-token.ts",
  ".github/workflows/ci.yml",
  "pnpm-lock.yaml",
  "compose.yaml",
];

describe("このリポジトリ自身のパス", () => {
  const tracked = new Set(
    execFileSync("git", ["ls-files"], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      encoding: "utf8",
    })
      .split("\n")
      .filter((path) => path !== ""),
  );

  it.each(REAL_SENSITIVE_PATHS)("%s は実在する", (path) => {
    expect(tracked.has(path), `${path} が見つからない（名前が変わった？）`).toBe(true);
  });

  it.each(REAL_SENSITIVE_PATHS)("%s は影響が大きいと判定される", (path) => {
    expect(touchesSensitivePath([path])).toBe(true);
  });
});

describe("touchesSensitivePath", () => {
  it("何も変更していなければ false", () => {
    expect(touchesSensitivePath([])).toBe(false);
  });

  it.each([
    // **CI / デプロイの設定** — 壊すと「検査そのもの」が効かなくなる
    [".github/workflows/ci.yml", "CI の定義"],
    [".github/CODEOWNERS", "レビューを誰に強制するか"],
    ["Dockerfile", "実行環境"],
    ["compose.yaml", "実行環境"],
    ["vercel.json", "デプロイ設定"],
    ["infra/main.tf", "インフラ定義"],
    // **CI は道具立てが分かれる。** どれか 1 つを前提にすると他所で当たらない
    [".circleci/config.yml", "CI の定義"],
    [".travis.yml", "CI の定義"],
    ["azure-pipelines.yml", "CI の定義"],
    ["bitbucket-pipelines.yml", "CI の定義"],
    // **依存のロックファイル** — 何が動くかが変わる
    ["pnpm-lock.yaml", "依存の固定"],
    ["package-lock.json", "依存の固定"],
    ["go.sum", "依存の固定"],
    // **一般則で拾う。** 列挙は必ず古くなり、古くなった先は取りこぼし側である
    ["bun.lock", "依存の固定"],
    ["deno.lock", "依存の固定"],
    ["uv.lock", "依存の固定"],
    ["Pipfile.lock", "依存の固定"],
    [".terraform.lock.hcl", "依存の固定"],
    // **頭字語が続く書き方でも語に割れること**
    ["src/RBACPolicy.ts", "誰が何をしてよいか"],
    ["src/OAuth2Callback.ts", "誰が入れるか"],
    ["src/AuthNGuard.ts", "誰が入れるか"],
    // **シークレットと鍵**
    [".env", "秘密情報"],
    ["config/app.pem", "秘密鍵"],
    // **認証・認可**
    ["src/auth/session.ts", "誰が入れるか"],
    ["src/lib/authGuard.ts", "誰が入れるか"],
    ["app/api/oauth/route.ts", "誰が入れるか"],
    ["src/rbac/rules.ts", "誰が何をしてよいか"],
    // **課金**
    // **規則 1 つだけに当たるパスを選ぶ。** 2 つに当たると、
    // 片方を外しても緑のままになる（`billing/invoice` で実際にそうなった）
    ["src/billing/plan.ts", "お金"],
    // **DB のマイグレーション** — 戻せない変更になりうる
    ["supabase/migrations/0001_init.sql", "データの形"],
  ])("%s は影響が大きい（%s）", (path) => {
    expect(touchesSensitivePath([path])).toBe(true);
  });

  it.each([
    ["src/ui/button.tsx"],
    ["README.md"],
    ["src/domain/graph/dependency-graph.ts"],
    // **`author` を `auth` で拾わない。** 語の一部で当てると、
    // **git の author を触っただけで「影響が大きい」になる**
    ["src/domain/author.ts"],
    ["docs/authoring-guide.md"],
  ])("%s は普通の変更", (path) => {
    expect(touchesSensitivePath([path])).toBe(false);
  });

  it("1 つでも当たれば true", () => {
    // **拾いすぎ側へ倒す。** 取りこぼすと「読まずにマージしてよい」と言ってしまう
    expect(touchesSensitivePath(["README.md", "src/ui/button.tsx", ".env"])).toBe(true);
  });

  it("先頭の ./ や大文字小文字の違いで取りこぼさない", () => {
    // **表記の揺れで判定が変わらない。** 取りこぼしのほうが高くつく
    expect(touchesSensitivePath(["./.github/workflows/ci.yml"])).toBe(true);
    expect(touchesSensitivePath(["Src/Auth/Session.ts"])).toBe(true);
    expect(touchesSensitivePath(["DOCKERFILE"])).toBe(true);
  });
});
