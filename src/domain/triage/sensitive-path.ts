/**
 * 変更されたパスから「壊すと影響が大きいか」を決める。
 *
 * `classifyRiskTier` の 2 本柱のうち、CI ではないほうの入力である。
 * ここは純粋関数で、GitHub のレスポンス型ではなくパスの文字列だけを受け取る。
 *
 * **マルチテナントである**（`AGENTS.md` §1）。**対象リポジトリは 1 つではない**ので、
 * 特定のリポジトリの構成（`src/` の切り方、独自のディレクトリ名）を前提にした一覧を
 * 書くと**他所で当たらない**。ここに並べるのは、**どのリポジトリでも「壊すと影響が
 * 大きい」と言えるもの**だけである。
 *
 * **リポジトリごとの設定は作らない。** MVP のスコープ外（`AGENTS.md` §1「今は作らない」）。
 * 規則を定数として外に出してあるので、**設定にしたくなったらここを差し替える**形にできるが、
 * **今は要らない**（YAGNI）。
 *
 * ## どちらへ倒すか
 *
 * **拾いすぎ側へ倒す。** 非対称だからである。
 *
 *   取りこぼし … `fast-track` になり、**「内容を読まずにマージしてよい」と表示する**。
 *                認証まわりの 3 行の変更にそう出る
 *   拾いすぎ   … `high-risk` になり、**レビューが 1 回増える**だけ
 *
 * **この一覧は必ず不完全である。** 足りないものを足しても、次に別のものが出る——
 * 新しい CI・新しいパッケージマネージャ・新しい書き方はこれからも増える。
 * **だから拾いすぎ側へ倒してある。** 取りこぼしを見つけたときは、
 * **設計の失敗ではなく前提**だと読んでほしい（足すのは正しい対応である）。
 *
 * **一般則が書けるなら一般則、書けないなら列挙。** 列挙は必ず古くなり、
 * **古くなった先は取りこぼし側**である。ロックファイルは名前の規則がはっきりしているので
 * 一般則にし、CI の設定は道具ごとに名前が違うので列挙にしてある。
 *
 * **当たらないことは避けられない。** だからこそ、画面が
 * 「壊すと影響が大きいパスに触れています」と**理由まで出している**ことが効く——
 * **人が見て「違う」と分かる。** 判定を隠していないので、多少拾いすぎても害は小さい。
 */

/**
 * ファイル名そのものが意味を持つもの。
 *
 * **CI・デプロイ・依存の固定**は、どのリポジトリでも「壊すと影響が大きい」。
 * CI の定義が変われば**検査そのものが効かなくなり**、ロックファイルが変われば
 * **動くコードが変わる**（差分に現れない）。
 */
const SENSITIVE_FILE_NAMES: readonly string[] = [
  // 誰にレビューを強制するか
  "codeowners",
  // 実行環境
  "dockerfile",
  "procfile",
  // デプロイ先の設定
  "vercel.json",
  "netlify.toml",
  "fly.toml",
  // CI。**どの道具を使うかは、インストール先ごとに違う**（マルチテナント）。
  // ここを 1 つに絞ると、別の CI を使うリポジトリで当たらない。
  "jenkinsfile",
  ".gitlab-ci.yml",
  ".travis.yml",
  ".travis.yaml",
  ".drone.yml",
  "appveyor.yml",
  "buildspec.yml",
  "cloudbuild.yaml",
  // 依存の固定（何が動くかが変わる）。**`.lock` で終わるものは一般則が拾う**ので、
  // ここに並べるのは**その形をしていないもの**だけである。
  "pnpm-lock.yaml",
  "package-lock.json",
  "go.sum",
  "requirements.txt",
];

/** 名前の末尾でだけ決まるもの。**列挙より一般則を優先する。** */
const SENSITIVE_FILE_SUFFIXES: readonly string[] = [
  // bun / deno / uv / Pipfile / cargo / yarn / poetry / composer …
  // **列挙しなくても入る。** 新しいパッケージマネージャが出ても取りこぼさない
  ".lock",
  // terraform の依存固定（`.lock.hcl`）。拡張子だけでは `.hcl` を拾えない
  ".lock.hcl",
];

/** 名前の頭でだけ決まるもの（`compose.yaml` / `docker-compose.yml` / `.env.production` など）。 */
const SENSITIVE_FILE_PREFIXES: readonly string[] = ["compose.", "docker-compose.", ".env"];

/** 拡張子だけで秘密だと分かるもの。 */
const SENSITIVE_EXTENSIONS: readonly string[] = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".tf",
  ".tfvars",
];

/**
 * パスに現れる語。**語として一致したときだけ当てる。**
 *
 * 部分一致で当てると、`author.ts` が `auth` で拾われる——**git の author を触っただけで
 * 「影響が大きい」になる**。区切り（`-` `_` `.` `/`）と大文字の切り替わりで語に割ってから比べる。
 */
const SENSITIVE_WORDS: readonly string[] = [
  // 誰が入れるか / 何をしてよいか
  "auth",
  "authn",
  "authz",
  "authentication",
  "authorization",
  "oauth",
  "saml",
  "login",
  "logout",
  "session",
  "token",
  "credential",
  "credentials",
  "secret",
  "secrets",
  "password",
  "permission",
  "permissions",
  "acl",
  "rbac",
  "iam",
  // **略語も落とさない。** `auth` があって `jwt` が無い、という取りこぼし方をしていた
  // （このリポジトリの `src/infrastructure/github/app-jwt.ts` で実際に踏んだ）。
  // **同じ語彙の中で、綴りの短いほうだけが抜ける**のがこの穴の形である。
  "jwt",
  "jwk",
  "jwks",
  "jose",
  "sso",
  "mfa",
  "otp",
  "totp",
  "csrf",
  "xsrf",
  "hmac",
  "pkce",
  "tls",
  "ssl",
  "cors",
  // 壊れると復元しにくいもの
  "crypto",
  "encryption",
  "signature",
  "migration",
  "migrations",
  // お金
  "billing",
  "payment",
  "payments",
  "invoice",
  "subscription",
  // CI の定義。**道具ごとに置き場所が違う**ので、名前でも語でも拾う
  "workflows",
  "circleci",
  "pipelines",
];

/**
 * `src/lib/authGuard.ts` → `["src","lib","auth","guard","ts"]`
 *
 * **書き方を一通り割る。** 1 つでも割れないと、その書き方をした認証まわりのコードが
 * **丸ごと取りこぼしになる**（`RBACPolicy` が `rbacpolicy` の 1 語になっていた）。
 *
 *   camelCase      `authGuard`     → 小文字・数字 → 大文字
 *   PascalCase の頭字語 `RBACPolicy`    → **大文字の並び → 大文字＋小文字**
 *   末尾の数字      `OAuth2`        → 文字 → 数字
 */
function wordsOf(path: string): readonly string[] {
  return path
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
}

function isSensitive(path: string): boolean {
  // **語に割るほうは小文字化しない。** 先に潰すと `authGuard` の切れ目が消え、
  // 1 語として扱われて当たらなくなる（実際に踏んだ）。
  const normalized = path.replace(/^\.\//, "");
  const fileName = normalized.split("/").pop()?.toLowerCase() ?? "";

  if (SENSITIVE_FILE_NAMES.includes(fileName)) {
    return true;
  }
  if (SENSITIVE_FILE_PREFIXES.some((prefix) => fileName.startsWith(prefix))) {
    return true;
  }
  if (SENSITIVE_FILE_SUFFIXES.some((suffix) => fileName.endsWith(suffix))) {
    return true;
  }
  if (SENSITIVE_EXTENSIONS.some((extension) => fileName.endsWith(extension))) {
    return true;
  }
  const words = new Set(wordsOf(normalized));
  return SENSITIVE_WORDS.some((word) => words.has(word));
}

/** 1 つでも当たれば true。**触れていないことのほうを証明する**形にはしない。 */
export function touchesSensitivePath(changedPaths: readonly string[]): boolean {
  return changedPaths.some(isSensitive);
}
