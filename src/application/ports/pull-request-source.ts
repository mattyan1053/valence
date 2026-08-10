/**
 * PR 一覧を取ってくる口。
 *
 * **取ってくるだけで、解釈しない。** 応答をドメイン型へ移すのは境界（infrastructure）の
 * 仕事で、`application` はその実装を知らない。ここに Octokit や `fetch` の型が出てきたら
 * port の設計漏れである。
 */
export type PullRequestSource = {
  /**
   * ある PR 一覧を取る。
   *
   * **生の応答を返す**（検証と変換は `PullRequestMapper` の仕事）。
   * **取得に失敗したら投げる。** 空の一覧を返すと、
   * **「取得できなかった」が「PR が 0 件」に化ける**。
   */
  listPullRequests(): Promise<unknown>;
};
