/**
 * 生の応答をドメイン型へ移す口。
 *
 * **実装は infrastructure に置く**（応答の形と検証ライブラリを知るのはそこだけ）。
 * `application` は「`unknown` を入れると参照が出てくる」ことしか知らない。
 */

import type { PullRequestRef } from "../../domain/graph/dependency-graph";

/** 検証に落ちた 1 件。 */
export type InvalidPullRequest = {
  /**
   * 応答の何件目か（0 始まり）。**番号ではなく位置で示す**のは、
   * 番号そのものが読めないことがあるためである。
   */
  readonly index: number;
  /** 何が読めなかったか。 */
  readonly reason: string;
};

/**
 * 変換の結果。
 *
 * **落ちたものを黙って捨てない。** 捨てると「取得できたが読めなかった」と
 * 「そもそも無かった」が区別できず、**依存が抜けた図が正しい顔で出る**。
 */
export type PullRequestListing = {
  readonly pullRequests: readonly PullRequestRef[];
  readonly invalid: readonly InvalidPullRequest[];
};

/** **一覧そのものが読めなければ投げる**（0 件に丸めない）。 */
export type PullRequestMapper = (response: unknown) => PullRequestListing;
