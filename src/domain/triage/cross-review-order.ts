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
  /**
   * 最後に動いた時刻（ISO 8601）。
   *
   * **読めなかった行は持たない**（#719）——**境界が日時として検証し、通らなければ
   * 落とす。** **「読めなかった」を「動いていない」へ倒さない**ので、
   * **ここへ既定の時刻を埋めない。**
   */
  readonly updatedAt?: string;
};

/**
 * **最後に動いたものから。**
 *
 * **同じ時刻なら、置き場所と番号で決める**——**並びが揺れると、2 回開いたときに
 * 同じ画面に見えない**（**読む人は「何か変わった」と読む**）。
 *
 * **時刻を読めなかった行は下へ送る**（#719）。**落とさない**——**行は残して、
 * 読む人が決める**（`AGENTS.md` §5。**「読めなかった」を「いま動いた」へ倒さない**）。
 *
 * **`undefined` を大小の比較へ入れない。** **`undefined < "2026-…"` も
 * `undefined > "2026-…"` も `false`** なので、**素通りさせると「どちらが先か」が
 * 場合によって変わる**——**推移律が壊れ、答えが渡した順で変わる**
 * （**実測: 同じ 4 行を並べ替えて渡すと、読める 3 行の順まで入れ替わった**）。
 *
 * **渡されたものは書き換えない。**
 */
export function crossReviewOrder<Row extends CrossReviewRow>(rows: readonly Row[]): readonly Row[] {
  return [...rows].sort((left, right) => {
    const activity = byActivity(left.updatedAt, right.updatedAt);
    if (activity !== 0) {
      return activity;
    }
    const place = `${left.repository.owner}/${left.repository.name}`.localeCompare(
      `${right.repository.owner}/${right.repository.name}`,
    );
    return place === 0 ? left.number - right.number : place;
  });
}

/**
 * **動いた時刻で比べる。** **読めなかった側を下へ送る。**
 *
 * **0 は「この材料では決まらない」**である——**呼ぶ側が置き場所と番号で決める**
 * ので、**ここで揺れを作らない。**
 */
function byActivity(left: string | undefined, right: string | undefined): number {
  if (left === right) {
    return 0;
  }
  if (left === undefined) {
    return 1;
  }
  if (right === undefined) {
    return -1;
  }
  return left < right ? 1 : -1;
}
