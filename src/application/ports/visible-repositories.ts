/**
 * **このユーザーが見られるリポジトリ**を返す口。
 *
 * **`AGENTS.md` §6 の「ユーザーが閲覧権限を持つリポジトリのデータしか返さない」は、
 * installation トークンだけでは満たせない**——**installation トークンは
 * 「リポジトリへの操作」**を表すので、**誰がログインしていても同じものが見える。**
 * **「誰が何を見られるか」を表すのはユーザートークンのほう**である。
 *
 * **口は「誰の目で見るか」を引数で受ける。** **設定にも実装にも固定しない**
 * （§1。**installation は実行時に解決する**——**ここも同じ理由で、
 * 見る人は要求ごとに決まる**）。
 *
 * **検証済みのものだけを内側へ入れる**（§3）。**応答の形も検証ライブラリも
 * 知るのは境界（infrastructure）だけ**である。
 */

/** 見られるリポジトリ 1 件。**ドメインの語彙で持つ**（GitHub の応答型ではない）。 */
export type VisibleRepository = {
  readonly owner: string;
  readonly name: string;
};

/** 検証に落ちた 1 件。**位置で示す**（番号そのものが読めないことがある）。 */
export type InvalidVisibleRepository = {
  readonly index: number;
  readonly reason: string;
};

/**
 * 見えたものの一覧。
 *
 * **落ちたものを黙って捨てない**（`PullRequestSource` と同じ理由）。
 * **捨てると「読めなかった」が「見えなかった」に化ける**——
 * **見えるべきものが返らない側**の失敗が、**正しい顔で出る。**
 */
export type VisibleRepositoryListing = {
  readonly repositories: readonly VisibleRepository[];
  readonly invalid: readonly InvalidVisibleRepository[];
};

export type VisibleRepositories = {
  /**
   * **そのユーザーの目で**見られるリポジトリを返す。
   *
   * **取得に失敗したら投げる。** **空の一覧を返すと「取得できなかった」が
   * 「1 件も見えない」に化ける**——**ログインしているのに何も見えない画面**が、
   * **正常に見える。**
   */
  list(userAccessToken: string): Promise<VisibleRepositoryListing>;
};
