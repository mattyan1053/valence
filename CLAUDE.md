# CLAUDE.md

このリポジトリの共通ルールは `AGENTS.md` に集約している。**まずそれを読むこと。**

@AGENTS.md

---

## Claude Code 固有の補足

### 実行環境

ホストで `pnpm` / `npx` / `node` を直接実行しないこと。すべてコンテナ内で動かす。

```bash
make check      # コミット前に必ず通す（lint + typecheck + depcruise + test）
make sh         # コンテナのシェルに入る
```

コンテナが起動していない状態で `make` 系を叩くと自動で起動する。

### ファイル探索

`node_modules/` と `.next/` は巨大なので、Grep / Glob の対象に含めない。

### 作業の進め方

- **テストファースト**（`AGENTS.md` §5）。実装を書く前に落ちるテストを書き、実際に落ちることを確認する。
- レイヤ違反は `make check` の dependency-cruiser で落ちる。ルールを緩めて回避しない。
- 調査メモ・作業ログ・実装サマリーの `.md` をリポジトリに作らない。一時ファイルはスクラッチパッドに置く。
- 変更が一区切りしたら PR を作る。PR 作成時に Codex が自動でレビューするので、その指摘に対応する。
- `main` へ直接 push しない。
