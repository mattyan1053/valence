---
name: respond-to-review
description: PR に付いた Codex のレビュー指摘へ対応・返信するときに使う。指摘の取捨、インラインコメントへの個別返信、スレッドの resolve、再レビューの依頼、打ち切りの判断。
---

# Codex レビューへの対応

PR 作成時に Codex が自動でレビューする。再レビューは PR に `@codex review` とコメントする。

## 返信は各インラインコメントへ個別に返す

**PR 全体へのコメント 1 件にまとめない。** 指摘と対応の対応関係が追えなくなる。

```bash
# 指摘の一覧（id が返信先）
gh api repos/<owner>/<repo>/pulls/<n>/comments \
  --jq '.[] | "id=\(.id) \(.path):\(.line // .original_line)\n\(.body)\n"'

# 個別に返信する。本文はファイル経由で渡すこと
gh api --method POST repos/<owner>/<repo>/pulls/<n>/comments/<comment-id>/replies \
  -F body=@reply.md
```

**`-f body='...'` に本文を直書きしない。** 返信にはコマンド例を載せることが多く、
本文中の `'` がシェルのクォートを閉じてしまって、途中で切れた返信が投稿される。
気づきにくいので、最初からファイルに書いて `-F body=@<file>` で渡す。
一時ファイルはリポジトリ外（スクラッチパッド）に置く。

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
