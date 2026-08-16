/**
 * PR 一覧を取ってくる口。
 *
 * **検証済みのものだけを内側へ入れる。** 応答の形も検証ライブラリも知るのは
 * 境界（infrastructure）だけで、`application` は「参照が出てくる」ことしか知らない。
 * ここに `unknown` を通すと、**検証前の外部データが内側を通ってから外側で検証される**
 * ことになり、`AGENTS.md` §3 の不変条件が破れる。
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
 * 取ってきた一覧。
 *
 * **落ちたものを黙って捨てない。** 捨てると「取得できたが読めなかった」と
 * 「そもそも無かった」が区別できず、**依存が抜けた図が正しい顔で出る**。
 */
export type PullRequestListing = {
  readonly pullRequests: readonly PullRequestRef[];
  readonly invalid: readonly InvalidPullRequest[];
  /**
   * PR 番号から引ける head の commit（#331 のレビュー）。
   *
   * **マージは「見せたもの」に固定する**ため、**押す側まで運ぶ。**
   * **`PullRequestRef` へ足さない**——**あれは依存を決めるのに要る最小限**である。
   */
  readonly heads: ReadonlyMap<number, string>;
};

export type PullRequestSource = {
  /**
   * ある PR 一覧を取る。
   *
   * **取得に失敗したら投げる。** 空の一覧を返すと、
   * **「取得できなかった」が「PR が 0 件」に化ける**。
   */
  listPullRequests(): Promise<PullRequestListing>;
};
