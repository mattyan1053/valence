/**
 * 「PR 一覧を取ってきて、依存グラフと順序を出す」流れ。
 *
 * **UI も通信もこの流れを呼ぶ側になる。** 先に決めておかないと、双方が別々の形を作る。
 * ここが知っているのは **port と domain だけ**で、GitHub も検証ライブラリも知らない。
 */

import type { DependencyEdge, PullRequestRef } from "../../domain/graph/dependency-graph";
import { buildDependencyEdges } from "../../domain/graph/dependency-graph";
import type { DependencyOrder } from "../../domain/graph/dependency-order";
import { orderByDependency } from "../../domain/graph/dependency-order";
import type { ChangeSummary } from "../../domain/triage/risk-tier";
import type { ChangeSummarySource, UnavailableChangeSummary } from "../ports/change-summary-source";
import type { InvalidPullRequest, PullRequestSource } from "../ports/pull-request-source";

/**
 * レビューの交通整理に要るもの一式。
 *
 * **辺と順序を両方返す。** 描画は辺を、並べ替えは順序を使うので、どちらかに
 * 寄せると呼び出し側が同じ計算をやり直すことになる。
 */
export type ReviewOrderPlan = {
  readonly pullRequests: readonly PullRequestRef[];
  readonly edges: readonly DependencyEdge[];
  readonly order: DependencyOrder;
  /** 読めなかった PR。**0 件でないなら、この図には抜けがある。** */
  readonly invalid: readonly InvalidPullRequest[];
  /** PR 番号から引けるリスク判定の材料。**取れなかった PR は入らない。** */
  readonly changes: ReadonlyMap<number, ChangeSummary>;
  /** 材料を取れなかった PR。**0 件でないなら、その行は Tier を出せない。** */
  readonly changesUnavailable: readonly UnavailableChangeSummary[];
  /**
   * PR 番号から引ける head の commit（#331 のレビュー）。
   *
   * **マージを「見せたもの」に固定する**ために運ぶ——**盤面を出してから押すまでに
   * push されると、利用者が確かめていない head がマージされる。**
   */
  readonly heads: ReadonlyMap<number, string>;
};

export type ReviewOrderSources = {
  readonly pullRequests: PullRequestSource;
  readonly changes: ChangeSummarySource;
};

export type ReviewOrderOptions = {
  /**
   * 材料の取得を打ち切る合図を**作る手続き**。
   *
   * **期限の決め方は持たない。** どれだけ待つかは**表示の段取り**であって、
   * ユースケースの判断ではない——ここに時計を置くと、`application` が
   * **Node 標準ライブラリ以外を持つ**か、**試験が時間に依存する**かのどちらかになる。
   * **合図を受け取る形なら、どちらも要らない。**
   *
   * **作る手続きで受けるのは、数え始める位置のため**である（#316 のレビュー）。
   * **`AbortSignal.timeout` は作った瞬間から数え始める**ので、**合成ルートで
   * 作って渡すと、一覧の取得ぶんが材料の期限から引かれる**——**一覧に期限ぶん
   * かかった日は、材料に 0 秒しか残らない。**
   *
   * **落ちないので気づけない。** **画面も依存グラフも出て、リスク Tier だけが
   * 全 PR で欠ける**——**「材料がありません」は正常な表示でもある。**
   * **遅いのは PR が多いリポジトリ**なので、**交通整理がいちばん要る側で消える。**
   */
  readonly changesDeadline?: () => AbortSignal;
};

/**
 * 一覧を取り、依存グラフと順序を組み立てる。
 *
 * **取得の失敗は投げたまま通す。** 結果に載せると、空の計画と同じ型になり、
 * **「取得できなかった」が「PR が 0 件」に化ける**。呼び出し側は例外の有無で
 * 区別できる。
 */
export async function planReviewOrder(
  sources: ReviewOrderSources,
  options: ReviewOrderOptions = {},
): Promise<ReviewOrderPlan> {
  const { pullRequests, invalid, heads } = await sources.pullRequests.listPullRequests();
  const edges = buildDependencyEdges(pullRequests);
  const numbers = pullRequests.map((pullRequest) => pullRequest.number);
  // **合図はここで作る。** **一覧を取り終えてから数え始める**（#316 のレビュー）
  const changes = await collectChanges(sources.changes, numbers, options.changesDeadline?.());

  return {
    pullRequests,
    edges,
    order: orderByDependency(pullRequests, edges),
    invalid,
    heads,
    ...changes,
  };
}

/**
 * 材料を集める。**丸ごと落ちても投げない。**
 *
 * **一覧の取得とは扱いを変えている。** 一覧が落ちたら投げる——結果に載せると
 * **「取得できなかった」が「PR が 0 件」に化ける**（このファイルの上のコメント）。
 * **材料は化けない。** 取れなかった PR の行は残り、画面は「材料がありません」と出す
 * ので、**「無い」ではなく「読めなかった」と読める**（#112 / #117）。そして
 * **依存グラフだけでも交通整理の役に立つ**ので、材料のために画面ごと落とさない。
 *
 * **黙って捨てもしない。** 空の地図だけだと、**1 件も材料が無いのか、口が壊れているのか**
 * が区別できない。**丸ごと落ちたときは、全 PR を理由つきで `unavailable` に載せる。**
 *
 * **遅いときも縮退する。** 落ちるなら上の経路へ入るが、**遅い場合はどこにも入らず、
 * 呼び出し側の時間切れで画面ごと落ちる**（#119 のレビュー指摘 / #120）。
 * **合図を受けたら、依存グラフだけ先に返す。**
 *
 * **口の行儀に頼らない。** 合図を渡しても、**受け取らない実装・無視する実装**はありうる。
 * **待つのをやめる側と、取り消しを伝える側の両方**が要る——**片方だけだと、
 * 「縮退したのは呼んだ側だけ」か「止まらない」のどちらかになる。**
 */
async function collectChanges(
  source: ChangeSummarySource,
  numbers: readonly number[],
  deadline: AbortSignal | undefined,
): Promise<Pick<ReviewOrderPlan, "changes" | "changesUnavailable">> {
  // **切れているなら呼ばない。** 呼べば往復が始まるので、
  // **打ち切ったのに要求だけ飛ぶ**ことになる
  if (deadline?.aborted === true) {
    return timedOut(numbers);
  }
  try {
    const listing = await Promise.race([
      source.listChangeSummaries(numbers, { signal: deadline }),
      abortion(deadline),
    ]);
    if (listing === TIMED_OUT) {
      return timedOut(numbers);
    }
    return { changes: listing.summaries, changesUnavailable: listing.unavailable };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "材料を取得できませんでした";
    return {
      changes: new Map(),
      changesUnavailable: numbers.map((pullRequestNumber) => ({
        pullRequestNumber,
        kind: "unreadable" as const,
        reason,
      })),
    };
  }
}

/** 打ち切りの印。**「材料が空だった」と区別できる値**にする。 */
const TIMED_OUT = Symbol("timed-out");

/** 合図が鳴るまで返らない約束。**合図が無ければ永久に返らない**（競争しても影響しない）。 */
function abortion(deadline: AbortSignal | undefined): Promise<typeof TIMED_OUT> {
  return new Promise((resolve) => {
    deadline?.addEventListener("abort", () => resolve(TIMED_OUT), { once: true });
  });
}

/** 打ち切ったぶん。**「読めなかった」と同じ場所に出るが、同じものではない。** */
function timedOut(
  numbers: readonly number[],
): Pick<ReviewOrderPlan, "changes" | "changesUnavailable"> {
  return {
    changes: new Map(),
    changesUnavailable: numbers.map((pullRequestNumber) => ({
      pullRequestNumber,
      kind: "timedout" as const,
      reason: "期限までに材料が返りませんでした",
    })),
  };
}
