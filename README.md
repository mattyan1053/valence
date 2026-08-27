# Valence

[![CI](https://github.com/mattyan1053/valence/actions/workflows/ci.yml/badge.svg)](https://github.com/mattyan1053/valence/actions/workflows/ci.yml)
[![Audit](https://github.com/mattyan1053/valence/actions/workflows/audit.yml/badge.svg)](https://github.com/mattyan1053/valence/actions/workflows/audit.yml)
[![CodeQL](https://github.com/mattyan1053/valence/actions/workflows/codeql.yml/badge.svg)](https://github.com/mattyan1053/valence/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**AI 時代の PR コントロールセンター。**

AI によるコード生成が高速化した結果、開発のボトルネックは「書くこと」から「レビューしてマージすること」へ移った。
Valence は GitHub を置き換えず**拡張する** GitHub App として、PR の洪水に晒されるレビュアー側の交通整理を担う。

**複数のアカウント・複数の利用者を跨いで動く SaaS** として作っている。インストール先は 1 つではなく、「どのリポジトリを見るか」「誰が何を見てよいか」は実行時に決まる。

> [!NOTE]
> 現在 MVP 開発中。まだ動くものはない。

## できること（MVP）

- **依存グラフの可視化** — PR の base/head トポロジーから PR 間の依存関係を DAG として描画し、「どれから見ればいいか」を一目で示す
- **ルールベースのトリアージ** — 変更ファイル・行数・CI の通過状況から静的にリスク Tier を判定（Fast-track / 要レビュー / 要注意）
- **1 クリック Approve / Merge** — ダッシュボードから直接アクションを実行

LLM による要約や自動レビューは MVP スコープ外。まずは決定論的に判断できることだけを扱う。

## 技術スタック

Next.js (App Router) / React / TypeScript / Tailwind CSS / React Flow / Supabase / GitHub App (GraphQL API + Webhooks)

開発環境は Docker Compose に閉じており、ホスト環境には何もインストールしない。
本番は Vercel にデプロイする想定のため、リポジトリの `Dockerfile` は開発専用で本番では使われない。

## 開発

必要なのは bash / docker / git / flock だけ。Node も pnpm もホストには入れない。

```bash
cp .env.example .env  # 値を埋める
./task up             # 起動 = アプリが動く。初回はビルドと依存インストールも走る
./task check          # lint + typecheck + 依存方向検査 + テスト
./task help           # コマンド一覧
```

リモート VM で動かす場合は SSH ポートフォワードで繋ぐ。

```bash
ssh -L 3000:localhost:3000 -L 54321:localhost:54321 <user>@<remote-vm>
```

詳細な開発ルール・アーキテクチャ方針は [AGENTS.md](./AGENTS.md) を参照。

## GitHub App に要る権限

**権限は `.env` では決まらない。** [App の設定画面](https://github.com/settings/apps)
——**リポジトリの外**にある。**ここに書いてあるのは、この道具が実際に叩く口と、
その口に要る権限**である（出どころは
[Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)）。

| 権限 | 何に要るか | 叩く口 |
| --- | --- | --- |
| **Metadata: Read** | リポジトリの解決、見られるリポジトリの一覧 | `GET /repos/{owner}/{repo}`、`GET /user/repos` |
| **Pull requests: Read and write** | 盤面（PR 一覧・変更の要約・承認の一覧）と **Approve** | `GET /repos/{owner}/{repo}/pulls`、`GET /repos/{owner}/{repo}/pulls/{number}`、`GET /repos/{owner}/{repo}/pulls/{number}/files`、`POST /graphql`、**`POST /repos/{owner}/{repo}/pulls/{number}/reviews`** |
| **Contents: Read and write** | **Merge**（**Pull requests では足りない**） | **`PUT /repos/{owner}/{repo}/pulls/{number}/merge`** |
| **Checks: Read** | CI が通っているか | `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` |
| **Commit statuses: Read** | 古い形式の CI（status API） | `GET /repos/{owner}/{repo}/commits/{sha}/status` |

**App 自身の口は、権限ではなく秘密鍵で通る**（`GET /repos/{owner}/{repo}/installation`、
`POST /app/installations/{id}/access_tokens`）。**installation は実行時に解決する**ので、
設定には置かない。

**足りないとどうなるか。** **GitHub が `403` で断り**、**画面には
`unavailable`（`approve` / `merge`）が出る**——**押した人の権限ではなく、
App の権限が足りないときも同じ顔**である
（**user-to-server トークンの権限は「App の権限 ∩ その人の権限」**）。
**`unavailable` を見たら、まずここを見直すこと。**

**権限を足したら、既にインストールされている先で承認が要る**
（GitHub がオーナーへ確認を出す。**承認されるまで古い権限のまま**である）。

**能力を足すときは、この表も足す。** **叩く口はコードにあり**、
**`app-permissions.test.ts` が「表に無い口を叩いていないか」を数える**
——**表に足すまで `./task check` が赤くなる。**

## ライセンス

[MIT](./LICENSE)
