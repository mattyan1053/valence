/**
 * **横断の一覧を、見る順に並べる**（#683）。
 *
 * **1 リポジトリの盤面のような「推奨レビュー順」は作れない**——**依存は跨がない**
 * （`CrossRepositoryBoard` の但し書き）ので、**先に入れる PR という順序が無い。**
 * **リスク Tier も跨がない**（**ファイル変更に依り、往復が増える**。#662）。
 *
 * **跨いで使える材料は、最後に動いた時刻だけ**である。**動いたものを上へ出す**
 * ——**「新しい」とは言わない**（#664）が、**並べる根拠にはできる。**
 *
 * **リポジトリごとに固めない。** **固めると、置き場所の名前の順が「見る順」になる**
 * ——**横断で見たい理由は、置き場所を跨いで今どれが動いているかである。**
 *
 * **純粋関数である**（§3）。
 */

/** 並べるのに要るぶんだけ。**画面の行そのものは受けない**（`ui` を知らない）。 */
export type CrossReviewRow = {
  readonly repository: { readonly owner: string; readonly name: string };
  readonly number: number;
  /** 最後に動いた時刻（ISO 8601）。 */
  readonly updatedAt: string;
};

/**
 * **最後に動いたものから。**
 *
 * **同じ時刻なら、置き場所と番号で決める**——**並びが揺れると、2 回開いたときに
 * 同じ画面に見えない**（**読む人は「何か変わった」と読む**）。
 *
 * **渡されたものは書き換えない。**
 */
export function crossReviewOrder<Row extends CrossReviewRow>(rows: readonly Row[]): readonly Row[] {
  return [...rows].sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) {
      return left.updatedAt < right.updatedAt ? 1 : -1;
    }
    const place = `${left.repository.owner}/${left.repository.name}`.localeCompare(
      `${right.repository.owner}/${right.repository.name}`,
    );
    return place === 0 ? left.number - right.number : place;
  });
}
