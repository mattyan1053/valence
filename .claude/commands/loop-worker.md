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
前の周回が中断している。`dirty` で停止し、何が残っているかを報告する。

`main` を最新化する。

```bash
git switch main && git fetch origin main && git merge --ff-only origin/main
```

どれかに失敗したら `main-sync-failed` で停止する。

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
- 無い → ステップ 4（新規実装）

自分の open PR が 2 件以上あるなら、着手中の作業を放置して次を始めている。
`too-many-own-prs:<件数>` で停止する。**1 人が同時に持つ PR は 1 本。**

## 3. レビュー指摘に対応する

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

`./task check` が通らないまま 3 周した場合は `local-ci-failed:<PR番号>` で停止する。

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
`blocked` label を付けて理由をコメントし、`implementation-blocked:<Issue番号>` で停止する。
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

PR を作ったらこの周回は終わり。master がレビューとマージを判断する。

## 5. 空転を検出する

停止するときは **種別と対象の状態** の組で識別子を作る。

| 場面 | 識別子 |
| --- | --- |
| 作業ツリーが dirty | `dirty` |
| `main` の最新化に失敗 | `main-sync-failed` |
| open PR が 2 件以上 | `too-many-prs:<件数>` |
| `./task check` が通らない | `local-ci-failed:<PR番号>` |
| 実装が完了条件を満たせない | `implementation-blocked:<Issue番号>` |
| push / PR 作成に失敗 | `publish-failed:<Issue番号>` |

**識別子を持たない停止を作らない。時刻のように毎回変わる値を入れない。**

同じ識別子で 3 周続けて止まったら、次で全ループを止める。

```bash
./task loop:stop "<識別子>: <人が何をすれば再開できるか>"
```

**ファイルを直接作らない。** worktree は作業ツリーが独立しているため、
`loop/STOP` を自分の側に置いても、もう片方のループは走り続ける。
