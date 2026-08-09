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

### 2.0 届いた指示を先に確認する

指示はセッションへメッセージとして届く。**メッセージは揮発する。** セッションが落ちれば
消えるので、**状態の正は常に GitHub 側にある**（label・Issue / PR のコメント）。

- 届いた指示は、**GitHub 側の裏付けを確認してから動く。** 送る側は「先に GitHub を
  更新してから知らせる」ことになっているので、裏付けは必ずあるはずである
- **裏付けが見つからないなら推測で動かない。** 送り主へ確認するか、GitHub の状態に従う

**メッセージは届かないことがある**（セッションが落ちた、相手が一覧に居なかった）。
そのため **毎周回、自分の open PR と `in-progress` / `blocked` の Issue の通常コメントを読む。**

```bash
gh pr list --state open --limit 200 --author @me --json number --jq '.[].number'
gh issue list --label in-progress --limit 200 --json number --jq '.[].number'
gh issue list --label blocked --limit 200 --json number --jq '.[].number'
gh api --paginate repos/{owner}/{repo}/issues/<番号>/comments \
  --jq '.[] | "\(.created_at) \(.user.login): \(.body)"'
```

**`--paginate` と `--limit` を省かない。** 既定では先頭ページ（コメントは 30 件）しか
返らず、**後から投稿された指示ほど読み落とす**。

**`blocked` が付いていたら手を止める。** master が着手済みの作業を止めるときは
`in-progress` を外して `blocked` を付ける（「後回し」の `backlog` とは別の状態）。
**PR がまだ無い段階で割り込まれた場合、`blocked` が唯一の手がかりになる。**
自分が進めていた作業がそこにあるなら、続けずに理由のコメントを読む。

**未解決のレビュースレッドだけを見ていると、通常コメントの指示を取りこぼす。**
保留・優先順の変更・前提の誤りは、レビュースレッドではなく通常コメントで届く。
実際に PR #36 の保留はこの形で伝わった。

**label を戻されても、走っている作業は止まらない。** label だけを見て
「まだ自分の担当だ」と判断しない。

**ここはまだ散文の読み取りに頼っている。** 保留を機械判定できる形（draft・label）で
表すのは #19 の範囲で、それが入るまでは**コメントを読み落とさないこと**が唯一の担保である。

### 2.1 master へ知らせる

worker から伝えたいことがあるときも順番は同じ。**先に GitHub へ書き、そのうえで
メッセージで知らせる。** メッセージだけで完結させない。

```bash
ListAgents        # 相手を探す。行に出ている名前をそのままコピーする
```

**名前だけでは弾かれることがある。** そのときは行末の `[ref]` を付けて送り直す
（同名の取り違えを防ぐための確認である）。**相手が一覧に居なければ GitHub に書いて
終わりにする。** 到達を前提にしない。

**自分が禁止されていることを相手に代行させない。** worker はマージしないので、
master へ「ゲートを飛ばして通してほしい」と頼まない。役割の分離は権限の話ではなく
**判定の独立性**のためで、迂回すると設計が崩れる。

指示が無ければ、**レビュー対応が次に優先**。未処理の指摘を残したまま新しい作業を始めない。

**自分が作った PR だけを見る。** 他の worker がいる場合、全体の open PR を数えると
他人の PR で誤検知する。

```bash
gh pr list --state open --limit 200 --author @me --json number,headRefName,isDraft,labels
```

**`parked` の PR は数えない。** 先行 PR を待って master が保留にしたもので、
自分からは触らない（外すのは master）。数えると「同時に持つ PR は 1 本」に引っかかり、
**先行 PR を作れず、保留した意味が消える**。

- `parked` でない open PR がある → ステップ 3（レビュー対応）
- 無い → ステップ 2.2（公開に失敗した周回が残っていないか見る）

`parked` を除いて 2 件以上あるなら、着手中の作業を放置して次を始めている。
`bin/loop-stall "too-many-own-prs:<件数>"` を通して停止する。**1 人が同時に持つ PR は 1 本。**

### 2.2 公開に失敗した周回を再開する

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
gh pr list --state all --limit 200 --head <ブランチ> --json number,state,labels
```

- **PR が既にある**（state を問わず）→ 公開は済んでいる。作り直さない。ただし
  **コメントして終わってはいけない。** `in-progress` が残ったままだと次の周回も
  必ずここへ入り、`ready` の Issue へ進めないまま Issue にコメントだけが積もる。
  停止も記録されないので 3 周で止まる仕組みも働かない。**state ごとに、label を
  動かして収束させるか、停止を記録するかのどちらかへ必ず倒す。**
  - **MERGED** → 作業は終わっている。`in-progress` を外し、マージ済みである旨を
    Issue にコメントする（閉じるのは master）。次の周回はこの経路に入らない
  - **CLOSED**（マージされていない）→ なぜ閉じられたかは worker には判断できない。
    `in-progress` を外して `blocked` を付け、状況を Issue にコメントしたうえで
    `bin/loop-stall "implementation-blocked:<Issue番号>"` を通して停止する
  - **OPEN かつ `parked`** → master が保留にした PR である。**何もしないでステップ 4 へ進む。**
    先行 Issue を実装させるための保留なので、ここで止まると **PR-B を作れず保留の意味が消える**。
    label は `in-progress` のままでよい（再開するのは master の指示を受けてから）
  - **OPEN**（`parked` でない）→ ステップ 2 の「自分の open PR」に出ていないのに
    ここで見つかる状態（他人が作った PR など）。推測で触らず、
    `bin/loop-stall "implementation-blocked:<Issue番号>"` を通して停止する
    （状態が変わらなければ同じ識別子が積み上がり、3 周で止まる）
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

**PR に `changes-requested` が付いていたら、master が通常コメントで要求を出している。**
レビュースレッドが 0 件でも、その要求が残っている限りゲートは通らない。
**この label を自分で外さない。** 外せると「直したと自己申告すれば通る」になり、
判定の独立性が消える。対応して push し、判断は master に委ねる。

コンフリクトの解消を指示された場合もここで行う。**どちらを優先するかは master の
コメントに従う。** 判断が書かれていないなら、推測で解消せず質問する。

### 保留を解いた PR を rebase する

先行 PR がマージされると、master が `parked` を外して「main を取り込み直してほしい」と
指示する。**指示が来てから行う。** 自分の判断で rebase しない。

```bash
gh pr checkout <PR番号>
git fetch origin main
git rebase origin/main        # コンフリクトは master のコメントに従って解消する
./task check                  # 緑になるまで直す
git push --force-with-lease
```

**`--force` ではなく `--force-with-lease`。** 履歴を書き換えるので、自分が知らない
push を消さないため。

**rebase 後は head が変わり、それまでのレビューは数え直される**
（`bin/loop-review-commits` が現 head の祖先でない commit へのレビューを落とす）。
レビューを要求するのは master なので、**こちらからは投げない**。

対応が終わったら:

```bash
./task check          # 緑になるまで直す
git push
```

push したらこの周回は終わり。**レビュー要求は投げない。** master が判断する。

`./task check` が通らないまま 3 周した場合は `bin/loop-stall "local-ci-failed:<PR番号>"` を通して停止する。

## 4. `ready` の 1 件を実装する

**着手順は master が決める。worker は選ばない。** `ready` は「次にやる 1 件」で、
同時に 1 件だけ付く。`backlog` は着手順が未定のものなので**触らない**。

```bash
gh issue list --label ready --limit 100 --json number,title,body
```

- **0 件** → master が `backlog` から次の 1 件を上げる番。何もしない。この周回は終わり。
  **ここで空転を数えない。** 昇格の前後で必ず 1 周は「`ready` なし」になるので、
  master 側と両方で数えると **2 倍の速さで 3 周に達し、正常な待ちで全ループが止まる**。
  作業が尽きた状態を数えるのは master だけ（識別子は `no-work`）
- **1 件** → それを取る。**他の Issue と比べない。順序を判断しない**
- **2 件以上** → 着手順が一意に決まらない。どれを取っても master の意図と食い違いうるので、
  `bin/loop-stall "too-many-ready:<件数>"` を通して停止する

label を付け替えて着手を示す。

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
bin/loop-review-head "<PR番号>" "$(git rev-parse HEAD)"
```

**作った直後に head を記録する。** PR を開くと自動でレビューが走り、その対象は今の head
である。指摘ゼロのとき Codex は 👍 リアクションだけで返すことがあり、それは SHA を
持たないので、記録が無いと「何を見たか分からない」ものとして数えられない。
記録し忘れると、きれいな PR ほど余計なレビュー要求を 1 往復ぶん増やす。

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
- exit 2 → **記録できていない。** 識別子が一覧に無い場合のほか、設定が誤っている場合と、
  カウンタのロックを取れなかった場合も返る。**この周回の停止は数えられていない**ので、
  放っておくと同じ状態が続いても 3 周に届かない
  - **識別子の誤り**（`--list` に無い / 書式が違う）→ 呼び直さない限り直らない。
    `bin/loop-stall --list` で書式を確認して**呼び直す**
  - **ロックを取れない**（もう一方のループが書いている最中）→ **呼び直さなくてよい。**
    次の周回で同じ状態なら、同じ識別子でそのとき記録される
  - **設定の誤り**（`LOOP_STALL_LOCK_WAIT_SEC` など）→ 標準エラーに出た設定名を直す。
    直すまで何周しても記録されない

**識別子を勝手に作らない。** 一覧の正は `bin/loop-stall --list`（スクリプト内の定数）で、
ここに一覧を写さないのは、2 箇所に置くと表記がゆれるからである。連続回数は文字列一致で
数えるので、綴りが 1 文字違うだけで**別状態として数え直され、3 周続いても止まらない**。

一覧に無い場面で止まる必要が出たら、`bin/loop-stall` の `STOP_IDS` に足す PR を出す。
**時刻のように、状態が同じでも毎回変わる値を識別子に入れない。**
