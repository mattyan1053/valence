# AGENTS.md

このリポジトリで作業するすべての AI エージェント（Claude Code / Codex / その他）向けの共通指示。
人間の新規参加者が読んでも同じ内容で通用するように書いてある。

---

## 0. 応答言語

**応答・PR レビューコメント・PR 本文・Issue コメントは日本語で書くこと。**

- 英語で書かれた指示を受け取った場合でも、出力は日本語に揃える。
- コード中の識別子・型名・API 名は英語。
- コードコメントは日本語で構わない（「なぜ」を書く。「何を」はコードに語らせる）。
- **例外: コミットメッセージの件名だけは英語**（§8 参照。本文は日本語）。

---

## 1. プロダクト概要

**Valence** — AI 時代の PR コントロールセンター。

AI によるコード生成が高速化した結果、ボトルネックは「書く」ではなく「レビューしてマージする」に移った。
Valence は GitHub を**置き換えず拡張する** GitHub App として、レビュアー（管理者）側の交通整理を担う。

### MVP スコープ

生成 AI による要約・自動化は**初期スコープ外**。決定論的に判断できるものだけを扱う。

1. **依存グラフの可視化** — PR の base/head トポロジーとコミット履歴から PR 間の関係を DAG として描画
2. **ルールベースのトリアージ** — 変更ファイル・行数・CI 通過状況から静的にリスク Tier を判定（Fast-track / 要レビュー / 要注意）
3. **1 クリック Approve / Merge** — ダッシュボードから GitHub API を直接叩く

### スコープ外（今は作らない）

- LLM による PR 要約・自動レビュー
- GitHub 以外のホスティングサービス対応
- マルチテナントの課金・組織管理

---

## 2. 技術スタック

| 領域 | 採用技術 |
| --- | --- |
| ランタイム | Node.js 24 (Active LTS) |
| パッケージマネージャ | pnpm（`packageManager` フィールドで固定。npm / yarn は使わない） |
| フレームワーク | Next.js App Router + React 19 |
| 言語 | TypeScript（`strict` + `noUncheckedIndexedAccess`） |
| スタイル | Tailwind CSS v4 |
| Lint / Format | Biome（ESLint / Prettier は使わない） |
| 依存方向の検査 | dependency-cruiser |
| テスト | Vitest（単体・結合） / Playwright（E2E、後日） |
| バリデーション | Zod（境界での入力検証に必ず使う） |
| DB / 認証 | Supabase（PostgreSQL + GitHub OAuth + RLS）※ローカルスタックで開発 |
| GitHub 連携 | GitHub App（GraphQL API + Webhooks）、Octokit |
| グラフ描画 | `@xyflow/react` (React Flow) + dagre |
| 実行環境 | Docker Compose（ホストを汚さない） |

---

## 3. 開発環境

**ホスト環境には何もインストールしない。すべてコンテナ内で実行する。**

タスクランナーは `./task`（素の bash スクリプト）。`make` すらホストに要求しないため、
ホストに必要なのは **bash / docker / git だけ**。

```bash
./task help      # コマンド一覧
./task up        # 開発コンテナを起動 = アプリが動き出す (http://localhost:3000)
./task dev       # 開発サーバーのログを追う
./task sh        # 開発コンテナのシェルに入る
./task check     # lint + typecheck + depcruise + test を一括実行（コミット前に必ず）
./task down      # 停止
```

コンテナの `CMD` が `pnpm dev` なので、**起動していればアプリは動いている**。
依存の導入は entrypoint が面倒を見るため、clone 直後でも `./task up` だけでよい。

`./task` を経由せず直接叩く場合も、必ずコンテナ内で実行する:

```bash
docker compose exec app pnpm <script>
```

ホストで `pnpm` / `npx` / `node` を直接実行しないこと。

### Supabase ローカルスタック

```bash
./task db:up      # 起動
./task db:status  # 接続情報 (.env に貼る値)
./task db:psql    # psql で入る
./task db:reset   # マイグレーションから作り直す
./task db:down    # 停止
```

起動するのは **db / auth / rest / kong の 4 つだけ**。realtime・storage・edge_runtime・
local_smtp・analytics・studio は `supabase/config.toml` で無効にしてある。
MVP で使わないうえ、イメージだけで数 GB になるため。必要になったら個別に有効化する。

Supabase CLI は「ホストの Docker daemon にスタックを立てさせる」一方で「疎通確認は
自身の 127.0.0.1 を見る」ため、docker socket とホストのネットワーク名前空間の両方を要求する。
これを `app` に持たせるとアプリのコンテナがホスト root 相当の権限を常時抱えることになるので、
CLI 実行専用の使い捨てコンテナ (`supabase-cli` サービス) に切り出してある。
`app` は素の bridge ネットワークのままで、docker socket も持たない。

`app` は Supabase と同じ docker network にも参加している。**サーバー側から Supabase を
叩くときは、ホストの公開ポートではなく `http://kong:8000` を使うこと。**
ブラウザ側 (`NEXT_PUBLIC_*`) はコンテナ名を解決できないので、SSH ポートフォワード先の
`http://localhost:54321` を使う。この二重性を取り違えると原因が分かりにくい。

手元 PC からのアクセスは SSH ポートフォワーディングを使う:

```bash
ssh -L 3000:localhost:3000 -L 54321:localhost:54321 <user>@<remote-vm>
```

---

## 4. アーキテクチャ

DDD / クリーンアーキテクチャの**依存関係逆転**の考え方を採る。
形式主義には陥らず、「ビジネスルールがフレームワークに依存しない」ことだけを厳守する。

```
src/
  app/                  Next.js App Router。ルーティングと配線のみ。ロジックを書かない
  domain/               ビジネスルール。外部依存ゼロ（import できるのは Node 標準と自分自身だけ）
  application/          ユースケース。ports/ に interface を定義し、実装は知らない
  infrastructure/       ports の実装（GitHub GraphQL アダプタ、Supabase リポジトリ等）
  ui/                   React コンポーネント。表示に専念し、データ取得を自前でやらない
  composition/          合成ルート。ports に adapter を束ねて注入する唯一の場所
```

内側（`domain`）ほど安定し、外側（`app`）ほど変わりやすい。依存の矢印は常に内向き。

### 依存方向（dependency-cruiser で機械的に強制）

| レイヤ | import してよい先 | 禁止 |
| --- | --- | --- |
| `domain` | Node 標準ライブラリと `domain` 自身**のみ** | npm パッケージを含むすべて |
| `application` | `domain` と Node 標準ライブラリ**のみ** | 他レイヤすべて、および npm パッケージ全般 |
| `infrastructure` | `application`, `domain`, npm | `ui` `app` `composition` |
| `ui` | `domain`, 他の `ui`, React | `application` `infrastructure` `composition` |
| `composition` | すべて | — |
| `app` | `composition`, `ui`, `application`, `domain` | `infrastructure`（直接 import） |

差し替えたい実装を握るのは `composition` だけ。`app` や `ui` が `infrastructure` を直接掴むと、
テストで差し替えられなくなる。

`application` で Octokit や Supabase SDK を import したくなったら、それは port の設計漏れ。
SDK を隠す interface を `application/ports/` に切り、実装を `infrastructure` に置くこと。

違反は `./task check`（`.dependency-cruiser.mjs`）で落ちる。テストファイル（`*.test.ts`）は対象外。
**ルールを緩めて通すのではなく、設計を直すこと。**
どうしても例外が必要なら、なぜ必要かを `.dependency-cruiser.mjs` にコメントで書いてから追加する。

### 具体的な指針

- **ドメインは純粋関数で書く。** `PullRequest` の Tier 判定や DAG 構築は、GitHub API のレスポンス型ではなく自前のドメイン型を入力に取る。これで API を叩かずにテストできる。
- **外部データは境界で Zod で検証し、ドメイン型に変換してから内側へ渡す。** `any` / 未検証の `as` をレイヤ境界で使わない。
- **副作用は infrastructure に閉じ込める。** `fetch` / Supabase クライアント / `process.env` の直接参照が domain・application に出てきたら設計ミス。
- **`app/` は薄く保つ。** Route Handler や Server Component はユースケースを 1 つ呼んで結果を返すだけ。

---

## 5. 開発の進め方（テストファースト）

**新しい振る舞いを追加するときは、必ずテストを先に書く。**

1. **Red** — 期待する振る舞いを表す失敗するテストを書く。この時点でテストが失敗することを実際に確認する
2. **Green** — 通すための最小限の実装を書く
3. **Refactor** — テストが緑のまま設計を整える

- ドメインロジックにはテストが**必ず**要る。カバレッジ閾値は CI で強制する。
- テストはファイル名を `*.test.ts` とし、テスト対象と同じディレクトリに置く（co-location）。
- テスト名は日本語で、「何をすると何になるか」を書く。例: `it("base ブランチが未マージの PR は要注意 Tier になる")`
- 外部 I/O はモックせず、`ports` の interface に対するインメモリ実装（テストダブル）を使う。`vi.mock` によるモジュールモックは最後の手段。
- バグ修正のときも、**先に落ちる回帰テストを書いてから**直す。

---

## 6. コードをクリーンに保つ

- **命名がすべて。** コメントで補う前に名前を変える。
- **関数は 1 つのことをする。** ネストが 3 段を超えたら早期リターンか関数抽出を検討する。
- **推測でコードを足さない。** YAGNI。今の要件にない抽象化・設定項目・オプション引数を先回りで作らない。
- **重複は 3 回目に抽象化する。** 2 回目のコピペは許容範囲、3 回目で共通化する。
- **死んだコードは消す。** コメントアウトされたコードを残さない（Git が履歴を持っている）。
- **後方互換の残骸を作らない。** まだ誰も使っていない機能に「移行期間」は不要。古いほうを消す。
- **`any` を使わない。** どうしても型がつかない場合は `unknown` で受けて絞り込む。
- 既存ファイルを編集するときは、周囲のコードのスタイル・命名・粒度に合わせる。

---

## 7. ドキュメントの方針

**仕様の正はコードである。** 仕様書・設計書・ADR の類は原則として作らない。

- 作ってよいのは、**コードから読み取れないこと**だけ:
  - 外部サービスのセットアップ手順（GitHub App の作成方法など）
  - 「なぜこの選択をしなかったか」がコードに現れない意思決定
- 置き場所は `AGENTS.md` か `docs/` 配下。**新しい仕様書ファイルを勝手に増やさない。**
- 実装が変わったら、同じコミットで該当ドキュメントも直す。古い記述を残さない。
- 作業ログ・調査メモ・サマリーの類を**リポジトリにコミットしない**（一時ファイルはリポジトリ外に置く）。

---

## 8. Git / PR

- ブランチは `main` から切る。命名は `feat/...` `fix/...` `chore/...` `refactor/...`。
- **`main` へ直接 push しない。** 必ず PR 経由。
- PR は 1 つの関心事にひとつ。レビューしやすい大きさに割る（このプロダクト自体がそういう思想のツールである）。
- PR タイトル・本文は日本語。本文には「何を変えたか」ではなく「**なぜ**変えたか」と「どう検証したか」を書く。

### コミットメッセージ

**件名は gitmoji + Conventional Commits の英語形式、本文は日本語。**
件名は `git log --oneline` や GitHub の一覧に並ぶので英語で揃え、詳細は読み手（＝日本語話者）に合わせる。

```
<gitmoji> <type>: <subject>

<本文（日本語）: なぜこの変更が必要だったか。何をしたかは diff が語る>
```

- 件名は英語・命令形・小文字始まり・72 文字以内・末尾にピリオドを打たない。
- 絵文字は Unicode 文字そのものを使う（`:sparkles:` ではなく `✨`）。
- 本文は日本語。書くことがなければ省略してよい（件名だけのコミットは許容）。

| gitmoji | type | 用途 |
| --- | --- | --- |
| 🎉 | `init` | リポジトリの最初のコミット |
| ✨ | `feat` | 新機能 |
| 🐛 | `fix` | バグ修正 |
| ♻️ | `refactor` | 振る舞いを変えないリファクタ |
| ✅ | `test` | テストの追加・修正 |
| 📝 | `docs` | ドキュメント |
| 🔧 | `chore` | 設定ファイル |
| 👷 | `ci` | CI |
| ⬆️ | `deps` | 依存の更新 |
| 🔥 | `remove` | コード・ファイルの削除 |
| 🔒️ | `security` | セキュリティ修正 |
| ⚡️ | `perf` | パフォーマンス改善 |
| 💄 | `ui` | 見た目のみの変更 |

### Codex によるレビュー

このリポジトリでは PR 作成時に Codex が自動でレビューする。再レビューは PR に `@codex review` とコメントする。

Codex へ: **レビューコメントは日本語で書くこと。** 指摘は以下の優先順で:

1. 正しさのバグ（境界条件、エラーハンドリング漏れ、競合状態）
2. セキュリティ（§9 のチェックリスト）
3. アーキテクチャ境界の違反、テストの欠如
4. 可読性・命名

スタイルの好みは Biome が見ているので指摘しなくてよい。

**レビューの打ち切り基準。** 再レビューは回すたびに新しい指摘が出て終わらなくなる。以下を満たしたらマージしてよい:

- 優先度 1（正しさ）と 2（セキュリティ）の指摘が残っていない
- 3（境界違反・テスト欠如）に対応済み、または「対応しない理由」を PR にコメント済み
- 再レビューは原則 **2 周まで**。3 周目に出てきた新規の nit は Issue に落とすかそのまま見送る

「指摘がゼロになるまで」を目標にしない。マージを止めてよいのは正しさとセキュリティだけ。

---

## 9. セキュリティ（public リポジトリ）

**このリポジトリは public。** コミットする内容には常に注意する。

- **絶対にコミットしないもの:** GitHub App の秘密鍵 (`*.pem`)、App ID / Client Secret、Webhook Secret、Supabase の `service_role` キー、アクセストークン、smee のチャンネル URL、個人のメールアドレス・ホスト名・絶対パス。
- シークレットは `.env`（gitignore 済み）に置き、`.env.example` にはキー名とダミー値だけを書く。
- 設定ファイルにホストの絶対パスを埋め込まない（`${PWD}` などで解決する）。
- GitHub Webhook は必ず署名（`X-Hub-Signature-256`）を検証してから処理する。
- ユーザーが閲覧権限を持つリポジトリのデータしか返さないこと。Supabase では RLS を有効にし、`service_role` キーをクライアントへ渡さない。
- 外部からの入力（Webhook ペイロード、API レスポンス、クエリパラメータ）は Zod で検証してから使う。
- ログにトークン・秘密鍵・個人情報を出さない。

### ローカル Supabase のポートについて

Supabase CLI はローカルスタックのポート (54321 / 54322) を必ず `0.0.0.0` に publish する。
bind アドレスを変える設定は CLI に無い（`db.network_restrictions` はホスト版プロジェクト向けで、
ローカルには効かない）。しかも Docker の port publish は firewalld を迂回するため、
VM が属するネットワークからは既定パスワードの Postgres に到達できる。

**開発 VM が直接インターネットに公開されておらず、上位の仮想ルーター越しである前提で許容している。**
公開されたホストでこのスタックを上げないこと。塞ぐ場合は外部インターフェース側だけを
`DOCKER-USER` チェーンで落とせばよい（`app` は `host.docker.internal` 経由なので影響を受けない）。

---

## 10. 作業前後のチェックリスト

作業を終える前に必ず:

```bash
./task check
```

- [ ] テストを先に書いたか（新規の振る舞いの場合）
- [ ] `./task check` が通るか（lint / typecheck / 依存方向 / テスト）
- [ ] シークレット・絶対パス・個人情報をコミットに含めていないか
- [ ] 不要になったコード・ドキュメントを消したか
- [ ] 実装に合わせて `AGENTS.md` / `.env.example` を更新したか
