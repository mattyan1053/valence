# 2 エージェント・ループの運用

master と worker の 2 つの Claude セッションが、それぞれ `/loop` を回す。
**状態の正は GitHub**（Issue / PR / label / スレッド）に置く。セッションが落ちても状態は残る。

```
master (~/valence-master, worktree, 読み専用)   worker (~/valence, 実装・コンテナ)
  ├ open PR を見る                                ├ ready の Issue を取る
  ├ レビュー状況を判断                            ├ TDD で実装 → PR
  ├ bin/loop-gate → 合格ならマージ                ├ レビュー指摘に対応
  └ 作業を割って Issue 起票                       └ 完了報告
                        ↕ GitHub (Issue / PR / label)
```

## 止まらなくなる事故を防ぐ仕組み

**「レビューが止まらない」と「永久にマージされない」は同じ設計ミスの裏表**である。
片方だけ塞ぐともう片方が出る。4 層で塞いである。

| 層 | 仕組み | 防ぐもの |
| --- | --- | --- |
| 1 | 現 head がレビュー済みなら再要求しない（`bin/loop-review-budget`） | 何も変わっていないものの再レビュー |
| 2 | レビュー回数の上限（既定 2 回） | 修正 → レビュー → 修正 の無限往復 |
| 3 | 上限到達後は「レビュー後の変更が手直しの範囲か」で判定（`bin/loop-gate`） | 上限がそのままデッドロックになること |
| 4 | 同じ停止識別子が 3 回続いたら `loop/STOP` | どの経路であれ空転し続けること |

**モデルの自制に依存しない。** 判断はすべてスクリプトの終了コードに落としてある。

## 絶対ルール

> **`bin/loop-gate <PR番号>` が終了コード 0 を返さない限り、理由を問わず
> `gh pr merge` を実行してはならない。**

- マージは `--match-head-commit <ゲートが検証した SHA>` を必ず付ける。
  付けないと、判定後に push された別の commit をマージしうる。
- `@codex review` は `bin/loop-review-budget` が 0 を返したときだけ投げる。
- `main` へ直接 push しない。
- **同時に open にしてよい PR は 1 本**。並行させるとレビュー量が本数倍で増える。

## 止め方

```bash
./task loop:stop      # loop/STOP を置く。両ループが次の周回の冒頭で停止する
./task loop:resume    # loop/STOP を消す
```

`loop/STOP` はコミットしない（`.gitignore` 済み）。

**worktree は作業ツリーが独立しているので、`loop/STOP` は共有されない。**
片方に置いただけでは、もう片方は走り続ける。`./task loop:stop` は全 worktree へ配るので、
**ループ自身が止まるときも必ずこのコマンドを使う**（ファイルを直接作らない）。

## 役割の境界

| | master | worker |
| --- | --- | --- |
| 作業場所 | `~/valence-master`（worktree） | `~/valence` |
| コード | 読むだけ（`git show`） | 書く |
| コンテナ / `./task check` | 使わない | 使う |
| Issue | **起票する** | label を更新する |
| PR | **マージする** | 作る・直す |
| `@codex review` | **要求する** | 要求しない |

master が実装に手を出さないのは、権限の話ではなく**判定の独立性**のためである。
自分が書いたものを自分で通すと、ゲートは形だけになる。

## label

| label | 意味 | 付ける人 |
| --- | --- | --- |
| `ready` | 着手してよい | master |
| `in-progress` | worker が着手中 | worker |
| `blocked` | 判断が要る。ループは触らない | どちらでも |

## セットアップ

```bash
./task loop:setup     # master 用 worktree と label を用意する
```

そのうえで 2 つの端末で:

```bash
cd ~/valence-master && claude   # → /loop /loop-master
cd ~/valence        && claude   # → /loop /loop-worker
```
