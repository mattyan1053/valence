# 2 エージェント・ループの運用

master と worker の 2 つの Claude セッションが、それぞれ `/loop` を回す。
**状態の正は GitHub**（Issue / PR / label / スレッド）に置く。セッションが落ちても状態は残る。

```
master (~/valence-master, worktree, 読み専用)   worker (~/valence, 実装・コンテナ)
  ├ open PR を見る                                ├ ready の Issue を取る
  ├ レビュー状況を判断                            ├ TDD で実装 → PR
  ├ bin/loop-gate → 合格ならマージ                ├ レビュー指摘に対応
  └ Issue 起票と着手順の決定                      └ 完了報告
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
| 4 | 同じ停止識別子が 3 回続いたら `loop/STOP`（`bin/loop-stall`） | どの経路であれ空転し続けること |

**モデルの自制に依存しない。** 判断はすべてスクリプトの終了コードに落としてある。
第 4 層の回数も `bin/loop-stall` がディスク（git の共通ディレクトリ）に持つので、
セッションをまたいでも失われない。

第 1 層と第 3 層は「何がレビュー済みか」を SHA で見るが、**指摘ゼロのとき Codex は
👍 リアクションだけで返すことがあり、それは SHA を持たない**。応答側から推定すると
未レビューの変更を通してしまうので、**レビューが走る直前の head を先に記録する**
（`bin/loop-review-head`。PR を作った直後と、レビューを要求する直前）。
記録より後に来た応答はその SHA を見たと確定でき、記録より前の応答は数えない。
ループの外で作られた PR には作成時の記録が無いので、master が「SHA の分からない実行」を
1 件だけ埋める（分からない head を推測で埋めない。対応した応答は数えずに消費する）。

第 4 層は文字列一致で数えるため、**停止識別子の表記がゆれると数え直しになり、
3 周続いても止まらない**。識別子の正は `bin/loop-stall` の `STOP_IDS`（`--list` で見られる）
1 箇所だけに置き、一覧に無い識別子で呼ばれたら exit 2 で弾く。手順書へ写さないのは、
2 箇所に持つと片方だけ直したときに食い違うからである（実際に食い違った）。

## 絶対ルール

> **`bin/loop-gate <PR番号>` が終了コード 0 を返さない限り、理由を問わず
> `gh pr merge` を実行してはならない。**

- マージは `bin/loop-merge <PR番号> <ゲートが検証した SHA>` で行う。`--match-head-commit` を
  内側で付ける（付けないと判定後に push された別の commit をマージしうる）。
  master は detached HEAD の worktree なので、`gh pr merge` は成功しても非ゼロを返す。
  **成否は終了コードではなくマージ後の PR の state で判定する。**
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
| Issue | **起票する・着手順を決める** | label を更新する |
| PR | **マージする** | 作る・直す |
| `@codex review` | **要求する** | 要求しない |

master が実装に手を出さないのは、権限の話ではなく**判定の独立性**のためである。
自分が書いたものを自分で通すと、ゲートは形だけになる。

**どちらのループも毎周回の冒頭で `origin/main` へ追随する。** worker は `main` を
fast-forward し、master は worktree を `origin/main` へ detach し直す。これが無いと
worktree は作った時点の commit に貼り付き、**マージした改善が master 自身に届かない**
（手順書もスクリプトも古い版のまま動き続ける）。

## label

| label | 意味 | 付ける人 |
| --- | --- | --- |
| `backlog` | 起票済み。着手順は未定 | master |
| `ready` | **次にやる 1 件。同時に 1 件だけ** | master |
| `in-progress` | worker が着手中 | worker |
| `blocked` | 判断が要る。ループは触らない | どちらでも |

**着手順は master が決める。** worker は `ready` の 1 件を取るだけで、順序を判断しない。
`gh issue list` は新しい順に返すため、worker に選ばせると実質 LIFO になり、
古い Issue が後回しになるうえ、割り込みを伝える手段も無くなる。

`ready` が 2 件以上あると着手順が一意に決まらない。どちらのループも
`bin/loop-stall "too-many-ready:<件数>"` を通して止める。

## セットアップ

```bash
./task loop:setup     # master 用 worktree と label を用意する
```

そのうえで 2 つの端末で:

```bash
cd ~/valence-master && claude   # → /loop /loop-master
cd ~/valence        && claude   # → /loop /loop-worker
```
