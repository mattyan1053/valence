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

## ライセンス

[MIT](./LICENSE)
