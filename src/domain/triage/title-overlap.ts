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
   * **いちばん近い 1 本だけ。** **同じ並びが無ければ `undefined`。**
   *
   * **全部の組を出さない。** **かかりが本数の 2 乗 × タイトルの長さの 2 乗**になり、
   * **実測で 100 本 × 256 文字が 46 秒**だった（**盤面はこれを描くたびに呼ぶ**）。
   * **2 文字の並び（bigram）の重なりで先に絞り**、**いちばん近い 1 本にだけ、
   * 正確な「いちばん長い並び」を求める。**
   *
   * **落としたぶんは黙って消えない**——**残りは同じ画面の別の行に出る**
   * （**相手の側からは、こちらが「いちばん近い 1 本」になりうる**）。
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
   * **一覧から読めなかった PR の件数**（`fileOverlapsFor` と同じ。**並びも合わせる**）。
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
      { match: matchOf(candidate.number, titles, grams), partial },
    ]),
  );
}

/** タイトルを 2 文字の並びへ落とす。**絞り込みに使う**（正確な比較はこの後）。 */
function bigrams(title: string | undefined): ReadonlySet<string> {
  const found = new Set<string>();
  for (let i = 0; i + 1 < (title?.length ?? 0); i += 1) {
    found.add((title as string).slice(i, i + 2));
  }
  return found;
}

/**
 * いちばん近い 1 本を選び、**その相手とだけ正確に比べる。**
 *
 * **絞り込みは 2 文字の並びの重なりで行う**——**本数の 2 乗で回るのはこちら**で、
 * **タイトルの長さには比例する**（**2 乗にはならない**）。
 */
function matchOf(
  number: number,
  titles: ReadonlyMap<number, string | undefined>,
  grams: ReadonlyMap<number, ReadonlySet<string>>,
): TitleMatch | undefined {
  const own = titles.get(number);
  const ownGrams = grams.get(number);
  if (own === undefined || own === "" || ownGrams === undefined) {
    return undefined;
  }

  const partner = bestPartner(number, ownGrams, titles, grams);
  if (partner === undefined) {
    return undefined;
  }
  // **ここまで来た相手とは、必ず 2 文字以上が同じ**である
  // ——**選んだのは「2 文字の並びが重なった」相手**なので、
  // **空になる道が無い**（**空を返す分岐を置くと、通らない枝になる**）
  return { number: partner, shared: longestShared(own, titles.get(partner) as string) };
}

/**
 * **2 文字の並びがいちばん重なる相手。**
 *
 * **ここが本数の 2 乗で回る**——**タイトルの長さには比例するが、2 乗にはならない。**
 * **正確な比較は、選んだ 1 本にだけ行う。**
 */
function bestPartner(
  number: number,
  ownGrams: ReadonlySet<string>,
  titles: ReadonlyMap<number, string | undefined>,
  grams: ReadonlyMap<number, ReadonlySet<string>>,
): number | undefined {
  let best: number | undefined;
  let bestScore = 0;

  for (const [other, otherGrams] of grams) {
    // **自分自身とは比べない**
    if (other === number || titles.get(other) === undefined) {
      continue;
    }
    const score = sharedCount(ownGrams, otherGrams);
    // **同じ点なら番号の小さい順**——**呼ぶたびに揺れると、理由が読めない**
    if (score > bestScore || (score === bestScore && score > 0 && other < (best ?? other))) {
      bestScore = score;
      best = other;
    }
  }
  return best;
}

function sharedCount(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let count = 0;
  for (const gram of right) {
    if (left.has(gram)) {
      count += 1;
    }
  }
  return count;
}

/**
 * **2 つの文字列に共通する、いちばん長い並び。**
 *
 * **呼ぶのは 1 本あたり 1 回だけ**（`matchOf` が絞り込んだ相手とだけ）。
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
