---
name: respond-to-review
description: PR に付いた Codex のレビュー指摘へ対応・返信するときに使う。指摘の取捨、インラインコメントへの個別返信、スレッドの resolve、再レビューの依頼、打ち切りの判断。
---

# Codex レビューへの対応

PR 作成時に Codex が自動でレビューする。再レビューは PR に `@codex review` とコメントする。

## 返信は各インラインコメントへ個別に返す

**PR 全体へのコメント 1 件にまとめない。** 指摘と対応の対応関係が追えなくなる。

**投稿は `bin/loop-review-reply` を通す。** **`gh api` を直接叩かない**——
**前の投稿が落ちた残骸が、次の投稿を全部塞ぐ**（下記）。**その始末はスクリプトが持つ。**

```bash
# 未解決スレッドの id を取る（下の「スレッドの resolve」と同じ問い合わせ）
bin/loop-review-reply <PR番号> <スレッドID> <本文ファイル>
```

- **exit 0** … 投稿できた（**投稿先の URL を出す**。着弾はこれで確かめる）
- **exit 1** … **消してはいけない pending review が塞いでいる。** 人が決める
- **exit 2** … 投稿できなかった。標準エラーに出た理由を読む

**本文は必ずファイルで渡す。** 返信にはコマンド例を載せることが多く、
**直書きすると本文中の `'` がシェルのクォートを閉じて、途中で切れた返信が投稿される**。
気づきにくいので、最初からファイルに書く。一時ファイルはリポジトリ外
（スクラッチパッド）に置く。

### 返信が 422 で落ちるとき——**pending review が 1 つ残っている**

```
Server Error (HTTP 502)                                    ← 1 回目（投稿されない）
user_id can only have one pending review per pull request  ← 再送すると 422
```

**文面は「2 つ目を書こうとしている」ように読めるが、実際は「1 つ目が空のまま
残っている」**である。**502 で落ちた投稿が、空の pending review を 1 つ残す。**

**`bin/loop-review-reply` はここを見て、消してよいものだけ消して投げ直す。**

| pending の中身 | どうなるか |
| --- | --- |
| **自分のもので、本文もコメントも空** | **消して投げ直す**（残骸だけを消す） |
| **本文かコメントが入っている** | **消さない**（`exit 1`）——**消すと書いた内容ごと消える** |
| **他の利用者のもの** | **消さない**（`exit 1`） |
| **そもそも 1 つも無い** | **消さない**（`exit 2`）——**別の理由である** |

**手で直すときも、この順で見ること。**

```bash
gh api repos/{owner}/{repo}/pulls/<n>/reviews \
  --jq '.[] | select(.state=="PENDING") | "\(.id) \(.user.login) body=\(.body|length)"'
gh api repos/{owner}/{repo}/pulls/<n>/reviews/<id>/comments --jq 'length'   # 0 でなければ消さない
```

**「422 なら pending を消す」だけを覚えない。** **別の理由で 422 が返ったときに、
関係のない下書きを消しにいく。**

## 返信に書くこと

- **指摘が妥当かどうかの判断**と、その理由
- 対応したならコミット SHA
- **実際に検証した結果**（「直しました」で終わらせない。再現できたか、直ったか）
- 対応しないと決めたなら、その理由

## スレッドの resolve

`main` のマージルールで**未解決スレッドがあるとマージできない**。返信したら resolve する。

**スレッドは必ずページングして取る。** 件数を決め打ちすると、超えた分の未解決
スレッドに気づけず、ブランチ保護でマージできない状態の原因が分からなくなる。

```bash
# 未解決スレッドの id を取る (--paginate と pageInfo が要る)
gh api graphql --paginate -f query='
query($endCursor: String) {
  repository(owner: "<owner>", name: "<repo>") {
    pullRequest(number: <n>) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved comments(first: 1) { nodes { path } } }
      }
    }
  }
}' --jq '.data.repository.pullRequest.reviewThreads.nodes[]
         | select(.isResolved==false) | "\(.id)\t\(.comments.nodes[0].path)"'

gh api graphql -f query='mutation{resolveReviewThread(input:{threadId:"<id>"}){thread{isResolved}}}'
```

## 打ち切りの判断

判断基準そのものは `AGENTS.md` の `## Code Review Rules` にある。要点は
**「指摘がゼロになるまで」を目標にしない**こと。マージを止めてよいのは正しさと
セキュリティだけで、再レビューは原則 2 周まで。

3 周目に出た指摘でも、nit ではなく実害があるものは直す。判断して、理由を書く。

## スタックした PR を扱うときの注意

`gh pr merge --delete-branch` で base ブランチが消えると、**それを base にしている
子 PR は自動クローズされ、reopen できなくなる**（base が存在しないため）。

子 PR の base を先に `main` へ付け替えてからマージすること。
親が squash マージされた後の子ブランチは、`git rebase main` では祖先の
コミットが衝突する。固有のコミットだけを載せ替える。

```bash
git rebase --onto main <親ブランチの旧 tip> <子ブランチ>
```
