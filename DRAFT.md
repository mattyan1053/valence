# AI時代のPRコントロールセンター（SaaS）開発要件・設計ドキュメント

## 1. プロジェクトの概要
* **プロダクト名:** AI時代のPRトリアージ・依存関係管理ダッシュボード
* **解決する課題:** AIによるコード生成の高速化に伴い、人間側のレビュー・マージ作業（PRの洪水）がボトルネックになっている問題の解消。
* **基本方針:** GitLabのようにシステム全体を置き換えるのではなく、GitHubを拡張する（GitHub Appとして連携する）アプローチをとる。作成者ではなく「レビュアー（管理者）」のための交通整理ツールを目指す。

---

## 2. コア機能（MVPスコープ）
開発を1〜2ヶ月でスモールスタートするため、生成AIによる複雑な要約や自動化は初期段階では除外し、決定論的アプローチに絞る。

1. **依存グラフの自動生成 (Graph View)**
   * ブランチのトポロジー（Base / Head）やコミット履歴を解析し、PR同士の関係性をDAG（有向非巡回グラフ）として可視化。
   * フロントエンドの描画には `React Flow` および自動レイアウト用ライブラリ（`dagre` 等）を採用。
2. **ルールベースの簡易トリアージ機能**
   * 変更ファイル・行数・CIの通過状況などから静的にリスクを判定し、Tier分類（Fast-track、要レビュー、要注意）を行う。
3. **1クリック Approve / Merge**
   * ダッシュボードから直接GitHub APIを叩き、アクションを実行できるUI。

---

## 3. 技術スタックとアーキテクチャ
管理コストを極限まで下げるため、クラウドサービスとコンテナを組み合わせる。

* **フロントエンド & BFF:** Next.js (App Router) on Vercel
* **データベース & 認証:** Supabase (PostgreSQL + GitHub OAuth + Row Level Security)
* **GitHub連携:** GitHub App (GraphQL API + Webhooks)

---

## 4. 開発環境（リモートVM + Docker環境）
ホスト環境（リモートVM）を汚さず、すべてをDockerコンテナ内に閉じ込める構成。

* **Next.js:** Dockerコンテナ内で `npm run dev` を実行。
* **GitHub Webhook転送:** `smee-client` を別コンテナで動かし、ローカルのNext.jsへ転送。
* **ローカルアクセス:** 手元PCからSSHポートフォワーディング（`ssh -L 3000:localhost:3000 user@remote-vm`）を利用してアクセス。

---

## 5. Claude（AIエージェント）への引き継ぎ用プロンプト

```markdown
以下のプロジェクト要件に基づき、AI時代のPRコントロールセンター（SaaS）のMVP開発を開始してください。

【前提条件】
- 技術スタック: Next.js (App Router), Supabase, Tailwind CSS, React Flow, GitHub App (GraphQL API)
- 開発環境: Docker Composeによるコンテナ化環境（リモートVM上）

【初期タスク】
1. プロジェクトのディレクトリ構成（Next.jsのApp Routerベース）の設計と提案
2. GitHub GraphQL APIを用いてリポジトリのOpen状態のPR一覧およびブランチ関係（base/head）を取得するBFF/APIルートのコード実装
3. 取得したPRデータを基に、React Flowで依存関係のグラフを描画するためのフロントエンドコンポーネントの基本実装

まずはステップ1（ディレクトリ構成の提案）から始めてください。
