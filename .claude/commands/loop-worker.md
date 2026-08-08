---
name: "Loop: Worker"
description: Issue の実装またはレビュー指摘への対応を 1 周だけ実行する
category: Workflow
tags: [workflow, loop-engineering]
---

worker ループを **1 周だけ** 実行する。`/loop` が本コマンドを反復して呼ぶ。

あなたは**実装役**である。マージしない。`@codex review` を要求しない。
どちらも master の役割で、判定の独立性のために分けてある。

## 絶対ルール

> **`gh pr merge` を実行してはならない。** ゲートを持たない側がマージすると、
> 分けた意味が無くなる。

`main` へ直接 push しない。`AGENTS.md` の規約に従う（特にテストファーストとレイヤ境界）。

## 1. 停止条件

`loop/STOP` が存在するなら、**何もせず直ちに停止する。**

存在しない場合、作業ツリーが clean であることを確認する。dirty なら、
前の周回が中断している。`bin/loop-stall dirty` を通して停止し、何が残っているかを報告する。

`main` を最新化する。

```bash
git switch main && git fetch origin main && git merge --ff-only origin/main
```

どれかに失敗したら `bin/loop-stall main-sync-failed` を通して停止する。

## 2. やることを決める

**人や master から直接指示が来ていれば、それを最優先で扱う。** Issue になっていない
依頼もある。指示の内容が Issue にすべき大きさなら、master に起票を依頼する。

指示が無ければ、**レビュー対応が次に優先**。未処理の指摘を残したまま新しい作業を始めない。

**自分が作った PR だけを見る。** 他の worker がいる場合、全体の open PR を数えると
他人の PR で誤検知する。

```bash
gh pr list --state open --limit 200 --author @me --json number,headRefName,isDraft
```

- 自分の open PR がある → ステップ 3（レビュー対応）
- 無い → ステップ 2.1（公開に失敗した周回が残っていないか見る）

自分の open PR が 2 件以上あるなら、着手中の作業を放置して次を始めている。
`bin/loop-stall "too-many-own-prs:<件数>"` を通して停止する。**1 人が同時に持つ PR は 1 本。**

### 2.1 公開に失敗した周回を再開する

push / PR 作成に失敗した周回は、**Issue が `in-progress` のままブランチだけが残る**。
ここを見ないと、ステップ 4 は `ready` の Issue しか探さないのでその Issue へ二度と戻れない。
`publish-failed:<Issue番号>` も 1 周目の 1 回しか記録されず、3 周に到達しないので
`loop/STOP` も置かれない。**失敗したまま誰も気づかない状態になる。**

```bash
gh issue list --label in-progress --limit 100 --json number,title
```

0 件ならステップ 4（新規実装）へ。あるなら、その Issue のブランチの状態を見る。

```bash
git branch --format='%(refname:short)' | grep -v '^main$'
git log --oneline main..<ブランチ>                          # コミットが載っているか
gh pr list --state all --limit 200 --head <ブランチ> --json number,state
```

- **PR が既にある**（state を問わず）→ 公開は済んでいる。作り直さない。label が
  残っているだけなので、Issue にその旨をコメントしてこの周回は終わり
- **PR が無く、コミットが載ったブランチがある** → 公開に失敗した周回の続きである。
  そのブランチへ切り替え、ステップ 4 の「PR を作る」から再開する。再び失敗したら
  同じ `publish-failed:<Issue番号>` を記録するので、3 周で止まる
- **ブランチが無い / コミットが載っていない** → 実装が途中。ステップ 4 の実装から続ける
  （label は `in-progress` のままでよい。付け替え直さない）

## 3. レビュー指摘に対応する

**先に対象 PR の head ブランチへ切り替える。** ステップ 1 で `main` にいるので、
そのまま直すと `main` 上で作業することになり、push しても PR は更新されないか、
禁止している `main` への直接 push を試みる。

```bash
gh pr checkout <PR番号>
git branch --show-current      # PR の headRefName と一致することを確認する
```

一致しない場合は `bin/loop-stall "wrong-branch:<PR番号>"` を通して停止する。**確認せずに編集しない。**

未解決スレッドを**ページングして**取る。件数を決め打ちすると、20 件を超えた PR で
取りこぼし、ブランチ保護でマージできない原因が分からなくなる。

手順は `.claude/skills/respond-to-review/` にある。要点だけ再掲する。

- 返信は**各インラインコメントへ個別に**返す。PR 全体へのコメント 1 件にまとめない
- 本文は必ずファイル経由（`-F body=@<file>`）。`'` でクォートが壊れる
- 「直しました」で終わらせない。**再現したか、直ったか**を書く
- **resolve しない。** 対応が十分かの確認と resolve は master の仕事である。
  自分で閉じると確認が働かない

指摘が妥当でないと判断したら、**直さずに理由を返信する。** 全部直すのが仕事ではない。

コンフリクトの解消を指示された場合もここで行う。**どちらを優先するかは master の
コメントに従う。** 判断が書かれていないなら、推測で解消せず質問する。

対応が終わったら:

```bash
./task check          # 緑になるまで直す
git push
```

push したらこの周回は終わり。**レビュー要求は投げない。** master が判断する。

`./task check` が通らないまま 3 周した場合は `bin/loop-stall "local-ci-failed:<PR番号>"` を通して停止する。

## 4. Issue を 1 つ取って実装する

```bash
gh issue list --label ready --limit 100 --json number,title,body
```

0 件なら、master が起票する番なので何もしない。この周回は終わり。

1 件取り、label を付け替えて着手を示す。

```bash
gh issue edit <N> --remove-label ready --add-label in-progress
```

ブランチを切る。命名は `AGENTS.md` に従う（`feat/` `fix/` `chore/` `refactor/` `docs/`）。

### 実装は必ずテストファースト

`AGENTS.md` §4 のとおり。

1. **Red** — 失敗するテストを書き、**実際に落ちることを確認する**
2. **Green** — 通すための最小限の実装
3. **Refactor** — 緑のまま整える

ドメインロジックにテストが無い状態で先へ進まない。
レイヤ境界は `./task check` の dependency-cruiser が見る。
**ルールを緩めて通さない。** 落ちたら設計を直す。

完了条件を満たせない、または Issue の記述だけでは判断できない場合は、
`blocked` label を付けて理由をコメントし、`bin/loop-stall "implementation-blocked:<Issue番号>"` を通して停止する。
**推測で埋めない。**

### PR を作る

```bash
./task check          # 緑を確認してから push
git push -u origin <ブランチ>
gh pr create --base main --title "<日本語>" --body-file <file>
```

本文には **「なぜ変えたか」と「どう検証したか」**を書く。`Closes #<Issue番号>` を入れる。
「通したコマンド」ではなく「何が起きることを確認したか」を書く。

**PR 本文に `@codex` を literal で書かない。** レビュー依頼ではなく「作業させるタスク」
として解釈され、その PR はレビューされなくなる（`AGENTS.md` 参照）。実際に踏んだ。

push または PR 作成に失敗したら `bin/loop-stall "publish-failed:<Issue番号>"` を通して停止する。

PR を作ったらこの周回は終わり。master がレビューとマージを判断する。

## 5. 空転を検出する

**周回が前へ進んだら、必ず次でカウンタを消す。**

```bash
bin/loop-stall --reset
```

マージできた・PR を作った・レビューを要求した・指摘へ対応した——何であれ状態が
動いたら呼ぶ。消し忘れると、同じ停止が 2 回起きたあと何周正常に進んでも、
後日の独立した 1 回で「3 周連続」と数えて全ループを止めてしまう。


**停止するときは必ず `bin/loop-stall` を通す。** 回数を自分で覚えない。セッションを
またぐと忘れて空転し続ける。使う識別子は上の各判定箇所に書いてある。

- exit 0 → まだ上限未満。そのまま停止して次の周回を待つ
- exit 1 → 上限に達した。**全ループが停止済み**。人の判断を待つ
- exit 2 → 識別子が一覧に無い。`bin/loop-stall --list` で正しい書式を確認して呼び直す

**識別子を勝手に作らない。** 一覧の正は `bin/loop-stall --list`（スクリプト内の定数）で、
ここに一覧を写さないのは、2 箇所に置くと表記がゆれるからである。連続回数は文字列一致で
数えるので、綴りが 1 文字違うだけで**別状態として数え直され、3 周続いても止まらない**。

一覧に無い場面で止まる必要が出たら、`bin/loop-stall` の `STOP_IDS` に足す PR を出す。
**時刻のように、状態が同じでも毎回変わる値を識別子に入れない。**
