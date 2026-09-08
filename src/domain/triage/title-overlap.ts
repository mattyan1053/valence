/**
 * **タイトルが同じ PR を並べる**（#630）。
 *
 * **利用者が実務で LLM に出させていたもの**（#626）——**決定論で出せる。**
 * **文字列の一致だけを見る**（`AGENTS.md` §1。**推論させた時点で「今は作らない」側**）。
 *
 * **「似ています」とは言わない。** **同じだった、いちばん長い並びと、その長さを出す**
 * ——**#639 が「遅れすぎ」と言わずに「35 遅れ」、#637 が「衝突する」と言わずに
 * 「3 個」と出したのと同じ線**である。**境界を引くのは、数を出したあと。**
 *
 * **ファイルの重なりはここに無い。** **`fileOverlapsFor`（#637）が持っている**
 * ——**2 つ目を作ると、判定が 2 箇所になる**（`AGENTS.md` §5）。
 * **ここが足すのは、文字列の一致だけ**である。
 *
 * **「似ている」と「同じ」は別**である（#637 / #630）。**同じファイルに触る PR は
 * 正しく分割された積み重ねでありうる**ので、**重複とは呼ばない。**
 *
 * **純粋関数である**（§3）。
 */

import { graphemeCount } from "../text/graphemes";

/** 比べる材料 1 件ぶん。**タイトルが取れていないなら `undefined`**（#542）。 */
export type TitledPullRequest = {
  readonly number: number;
  readonly title: string | undefined;
};

/** いちばん長く同じだった相手。 */
export type TitleMatch = {
  readonly number: number;
  /**
   * **同じだった、いちばん長い並び。**
   *
   * **これがそのまま理由になる**——**どの語が一致したかが読める**（#630 の完了条件）。
   * **長さは `shared.length`** で、**別に持たない**（**同じことを 2 箇所で言わない**）。
   */
  readonly shared: string;
};

export type TitleOverlapReport = {
  /**
   * **いちばん長く同じだった 1 本。** **求めた長さに満たなければ `undefined`。**
   *
   * **絞り込みで落としてよいのは、その長さに届かない相手だけ**である
   * （#653 のレビュー 2 周目）。**「いちばん近い 1 本」を先に選ばない**
   * ——**近さの指標と、測りたいもの（連続した一致の長さ）は別物**なので、
   * **1 本に絞った時点で取りこぼす。**
   *
   * **同じ長さなら番号の小さいほう。** **出すのは 1 本だけ**だが、
   * **落としたぶんは黙って消えない**——**相手の側からは、こちらが選ばれうる。**
   */
  readonly match: TitleMatch | undefined;
  /**
   * **測り切れていないか**（#637 の `OverlapReport.partial` と同じ）。
   *
   * **タイトルを読めなかった PR**（#542。**空文字は `undefined` で来る**）と、
   * **一覧から読めなかった PR** が入る。**どちらも「同じ並びがあるかもしれない」**
   * ——**「読めなかった」を「似ていない」にしない。**
   */
  readonly partial: boolean;
};

/**
 * **末尾の番号の飾りを外す。**
 *
 * **`（#123）` はほぼ全部の PR に付く**（`.claude/rules/git-workflow.md`）
 * ——**そこで一致しても、中身が似ていることにはならない。**
 */
const DECORATION = /(（#\d+[^）]*）|\(#\d+[^)]*\))\s*$/;

/**
 * **一覧ぶんをまとめて出す**（`fileOverlapsFor` と同じ形）。
 *
 * **かかりは「本数の 2 乗 × タイトルの長さの 2 乗」**である。**上限は入れていない**
 * ——**黙って切ると、この Issue が消しに来た状態（重複が見えない）に戻る。**
 */
export function titleOverlapsFor(
  candidates: readonly TitledPullRequest[],
  /**
   * **この長さ（書記素）以上の一致は取りこぼさない**、が契約である。
   *
   * **境界そのものは呼ぶ側が持つ**（#630 の「判断が要るところ」）——**ここは
   * 「どこまで探すか」として受ける。** **絞り込みの上限に使う**ので、
   * **domain が知らないと、落としてよいものが決められない。**
   */
  atLeast: number,
  /**
   * **一覧から読めなかった PR の件数**（`fileOverlapsFor` と同じ）。
   *
   * **既定値を置かない**——**書き忘れが「抜けは無い」へ倒れると、この判定が
   * まるごと素通りする。**
   */
  unreadableCount: number,
): ReadonlyMap<number, TitleOverlapReport> {
  const titles = new Map(
    candidates.map((candidate) => [candidate.number, candidate.title?.replace(DECORATION, "")]),
  );
  const grams = new Map([...titles].map(([number, title]) => [number, bigrams(title)]));
  // **読めていない PR が 1 本でもあれば、どの行の結果も下限である**
  const partial =
    unreadableCount > 0 || candidates.some((candidate) => candidate.title === undefined);

  return new Map(
    candidates.map((candidate) => [
      candidate.number,
      { match: matchOf(candidate.number, atLeast, titles, grams), partial },
    ]),
  );
}

/**
 * タイトルを 2 文字の並びへ落とす。**出現回数まで数える。**
 *
 * **種類では上限にならない**（#653 のレビュー 2 周目）——**`aaaaaaaaaa` は
 * 10 文字だが bigram は 1 種類**である。**出現回数なら上限になる**
 * ——**長さ L の共通部分列は、両方に L−1 個の出現を持つ。**
 */
function bigrams(title: string | undefined): ReadonlyMap<string, number> {
  const found = new Map<string, number>();
  for (let i = 0; i + 1 < (title?.length ?? 0); i += 1) {
    const gram = (title as string).slice(i, i + 2);
    found.set(gram, (found.get(gram) ?? 0) + 1);
  }
  return found;
}

/**
 * **求めた長さに届きうる相手を全部、正確に比べる。**
 *
 * **絞り込みは上限で行う**——**共通する出現数が `atLeast - 1` に満たなければ、
 * その長さの一致は無い**（対偶）。**落とすのはそれだけ**である。
 *
 * **絞り込みは UTF-16 の数で行い、判定は書記素で行う。** **書記素は UTF-16 より
 * 少ない**ので、**上限としてはそのまま成り立つ**——**多めに残るだけで、落とさない。**
 */
function matchOf(
  number: number,
  atLeast: number,
  titles: ReadonlyMap<number, string | undefined>,
  grams: ReadonlyMap<number, ReadonlyMap<string, number>>,
): TitleMatch | undefined {
  const own = titles.get(number);
  const ownGrams = grams.get(number);
  if (own === undefined || own === "" || ownGrams === undefined) {
    return undefined;
  }

  let best: TitleMatch | undefined;
  let bestLength = 0;
  for (const other of reachable(number, atLeast, titles, grams)) {
    const shared = longestShared(own, titles.get(other) as string);
    const length = graphemeCount(shared);
    if (length < atLeast) {
      continue;
    }
    // **同じ長さなら番号の小さいほう**——**呼ぶたびに揺れると、理由が読めない**
    if (length > bestLength || (length === bestLength && other < (best?.number ?? other))) {
      bestLength = length;
      best = { number: other, shared };
    }
  }
  return best;
}

/**
 * **求めた長さに届きうる相手だけ**を返す。
 *
 * **落としてよいのは、そこに届かないものだけ**である（#653 のレビュー 2 周目）
 * ——**「いちばん近い 1 本」を先に選ばない。**
 */
function* reachable(
  number: number,
  atLeast: number,
  titles: ReadonlyMap<number, string | undefined>,
  grams: ReadonlyMap<number, ReadonlyMap<string, number>>,
): Generator<number> {
  const ownGrams = grams.get(number) ?? new Map();
  for (const [other, title] of titles) {
    if (other === number || title === undefined) {
      continue;
    }
    if (sharedCount(ownGrams, grams.get(other)) >= atLeast - 1) {
      yield other;
    }
  }
}

/** 共通する 2 文字の並びの**出現数**（少ないほうを取った合計）。 */
function sharedCount(
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number> | undefined,
): number {
  let count = 0;
  for (const [gram, times] of right ?? []) {
    count += Math.min(times, left.get(gram) ?? 0);
  }
  return count;
}

/**
 * **2 つの文字列に共通する、いちばん長い並び。**
 *
 * **呼ぶのは絞り込みを通った相手だけ**である。
 * **前の行だけを持って進む**——**長さの 2 乗の表を全部持たない。**
 */
function longestShared(left: string, right: string): string {
  let previous = new Uint32Array(right.length + 1);
  let current = new Uint32Array(right.length + 1);
  let best = 0;
  let end = 0;

  for (let i = 1; i <= left.length; i += 1) {
    current.fill(0);
    for (let j = 1; j <= right.length; j += 1) {
      if (left[i - 1] === right[j - 1]) {
        const run = (previous[j - 1] ?? 0) + 1;
        current[j] = run;
        if (run > best) {
          best = run;
          end = i;
        }
      }
    }
    [previous, current] = [current, previous];
  }
  return left.slice(end - best, end);
}
