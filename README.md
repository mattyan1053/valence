# Valence

**AI 時代の PR コントロールセンター。**

AI によるコード生成が高速化した結果、開発のボトルネックは「書くこと」から「レビューしてマージすること」へ移った。
Valence は GitHub を置き換えず**拡張する** GitHub App として、PR の洪水に晒されるレビュアー側の交通整理を担う。

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

## 開発

```bash
cp .env.example .env    # 値を埋める
make up                 # 開発コンテナを起動
make dev                # http://localhost:3000
make check              # lint + typecheck + 依存方向検査 + テスト
```

詳細な開発ルール・アーキテクチャ方針は [AGENTS.md](./AGENTS.md) を参照。

## ライセンス

[MIT](./LICENSE)
