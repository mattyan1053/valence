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

import { graphemes } from "../text/graphemes";

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
 * **1 組あたり、先頭から何書記素まで比べるか。**
 *
 * **どんな分布でも有限の時間で描けること**が先である（#653 のレビュー 3 周目）
 * ——**盤面が開かないのは、行が 1 つ黙るのとは違う。**
 *
 * **実物のタイトルはこれより短い**（**このリポジトリの 100 本は最長 48 書記素**。
 * **GitHub の上限は 256**）。**超えたぶんは `partial` で言う**——**黙って切らない。**
 */
const COMPARED_PREFIX = 128;

/**
 * **1 枚の盤面で行う、正確な比較の回数。**
 *
 * **同じ題が並ぶのはふつうである**（**Dependabot**）——**そのとき絞り込みは効かず、
 * 組の数は本数の 2 乗**になる。**実測では 100 本・4950 組のうち 16 組**だったが、
 * **それはこのリポジトリの分布**であって、**別のインストール先では違う**（§1）。
 *
 * **数えて決めた。** **実物の 100 本で 16 組**、**題が似通う作りの 100 本で 460 組**
 * ——**そこは通し**、**全部が同じ題の 100 本（4950 組）では区切る。**
 * **かかりの上限は `1000 × 128 × 128`**（**1600 万マス**）である。
 *
 * **区切ったぶんは `partial` で言う**——**黙って切らない。**
 */
const COMPARISON_BUDGET = 1000;

/**
 * **1 枚の盤面で行う、絞り込みの手数。**
 *
 * **`COMPARISON_BUDGET` は正確な比較にしか掛からない** (#656)——**絞り込みそのものが
 * 本数の 2 乗**である。**どの 2 本も似ていない盤面では、予算に 1 度も触れないまま
 * 全部の組を絞り込む**（**似ていないのはふつうの状態**である）。
 *
 * **数えて決めた**（**このコンテナで実測**）。**どの 2 本も 9 個の bigram を
 * 共有しない 40 文字の題**で、**250 本 0.5 秒 / 500 本 2.9 秒 / 1000 本 14.6 秒 /
 * 2000 本 50 秒**だった——**上限のあった DP 側（最悪 0.6 秒）より 2 桁悪い。**
 *
 * **手数は「相手を 1 本見た回数」で数える**——**組の数では上限にならない**
 * （**1 組あたりのかかりが題の長さで決まる**。**GitHub の上限は 256 文字**）。
 *
 * **区切ったぶんは `partial` で言う**——**黙って切らない。**
 */
const SCREENING_BUDGET = 1_000_000;

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
 * **かかりには上限がある**（`COMPARED_PREFIX` / `COMPARISON_BUDGET` /
 * `SCREENING_BUDGET`）——**素のままだと「本数の 2 乗 × タイトルの長さの 2 乗」**で、
 * **同じ題が並ぶ盤面が開かなくなる**（#653 のレビュー 3 周目）。
 *
 * **絞り込みは索引から引く** (#656)——**相手を 1 本ずつ全部見ると、
 * どの 2 本も似ていない盤面（ふつうの状態）で本数の 2 乗**になる。
 *
 * **区切ったぶんは黙って消えない**——**`partial` が立ち、行に「測り切れていません」と
 * 出る。** **黙って切ると、この Issue が消しに来た状態（重複が見えない）に戻る。**
 */
export function titleOverlapsFor(
  candidates: readonly TitledPullRequest[],
  /**
   * **この長さ（書記素）以上の一致は取りこぼさない**、が契約である。
   *
   * **境界そのものは呼ぶ側が持つ**（#630 の「判断が要るところ」）——**ここは
   * 「どこまで探すか」として受ける。** **絞り込みの上限に使う**ので、
   * **domain が知らないと、落としてよいものが決められない。**
   *
   * **ただし、区切ったぶんは取りこぼす**（`COMPARED_PREFIX` / `COMPARISON_BUDGET` /
   * `SCREENING_BUDGET`）——**そのときは `partial` が立つ。**
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
  // **書記素の配列にしてから比べる**（#653 のレビュー 3 周目）——**符号単位で比べると、
  // 絵文字 1 個が 2 と数えられて短い一致が選ばれ**、**切り出しが上位サロゲートで
  // 切れて壊れた文字列が出る**（**gitmoji の多くが `D83D` を共有する**）
  const full = new Map([...titles].map(([number, title]) => [number, graphemes(title ?? "")]));
  const runes = new Map(
    [...full].map(([number, rune]) => [number, rune.slice(0, COMPARED_PREFIX)]),
  );
  const grams = new Map([...titles].map(([number, title]) => [number, bigrams(title)]));
  const byGram = indexByGram(grams);
  // **切ったぶんがあるか**——**黙って切らない**（#637 の `partial` と同じ語彙）。
  // **書記素どうしで比べる**——**符号単位の数と比べると、絵文字があるだけで
  // 「切った」になる**
  const cut = [...full].some(([, rune]) => rune.length > COMPARED_PREFIX);

  const budget = { left: COMPARISON_BUDGET, spent: false };
  const screening = { left: SCREENING_BUDGET, spent: false };
  const matches = new Map(
    candidates.map((candidate) => [
      candidate.number,
      matchOf(candidate.number, atLeast, { runes, grams, byGram }, budget, screening),
    ]),
  );
  // **読めていない PR が 1 本でもあれば、どの行の結果も下限である**
  const partial =
    unreadableCount > 0 ||
    candidates.some((candidate) => candidate.title === undefined) ||
    cut ||
    budget.spent ||
    screening.spent;

  return new Map(
    candidates.map((candidate) => [
      candidate.number,
      { match: matches.get(candidate.number), partial },
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
 * **求めた長さに届きうる相手を、予算の続く限り正確に比べる。**
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
  material: Material,
  budget: { left: number; spent: boolean },
  screening: { left: number; spent: boolean },
): TitleMatch | undefined {
  const own = material.runes.get(number);
  if (own === undefined || own.length === 0) {
    return undefined;
  }
  if (budget.left <= 0) {
    // **予算が尽きているなら、絞り込みもしない** (#656)——**絞り込みは本数の 2 乗**で、
    // **その結果を使う先がもう無い。** **区切ったことは `partial` で言う**
    budget.spent = true;
    return undefined;
  }

  let best: TitleMatch | undefined;
  let bestLength = 0;
  for (const other of reachable(number, atLeast, material, screening)) {
    if (budget.left <= 0) {
      // **区切ったことは `partial` で言う**——**黙って切らない**
      budget.spent = true;
      break;
    }
    budget.left -= 1;
    const shared = longestShared(own, material.runes.get(other) as readonly string[]);
    if (shared.length < atLeast) {
      continue;
    }
    if (beats(shared.length, other, best, bestLength)) {
      bestLength = shared.length;
      best = { number: other, shared: shared.join("") };
    }
  }
  return best;
}

/**
 * **2 文字の並びから引く索引を 1 度だけ作る**（#656。`fileOverlapsFor` と同じ形）。
 *
 * **素のままだと、相手を 1 本ずつ全部見る**——**似ていない題ほど並びは短い**ので、
 * **ふつうの盤面では、ここでほとんどの相手が出てこなくなる**
 * （**実物の 100 本で 9,554 手。索引を引かないと 207,702 手**）。
 *
 * **出現回数も載せる**——**載せないと、相手の表を毎回引き直すことになる**
 * （**実測で 2〜2.5 倍**）。
 */
function indexByGram(
  grams: ReadonlyMap<number, ReadonlyMap<string, number>>,
): ReadonlyMap<string, readonly Posting[]> {
  const byGram = new Map<string, Posting[]>();
  for (const [number, gram] of grams) {
    for (const [key, times] of gram) {
      const found = byGram.get(key);
      if (found === undefined) {
        byGram.set(key, [{ number, times }]);
      } else {
        found.push({ number, times });
      }
    }
  }
  return byGram;
}

/** 索引の 1 件。**番号と、その題での出現回数。** */
type Posting = {
  readonly number: number;
  readonly times: number;
};

/** **同じ長さなら番号の小さいほう**——**呼ぶたびに揺れると、理由が読めない。** */
function beats(
  length: number,
  other: number,
  best: TitleMatch | undefined,
  bestLength: number,
): boolean {
  return length > bestLength || (length === bestLength && other < (best?.number ?? other));
}

/** 比べる材料を 1 つに束ねる。**引数の数を増やさない。** */
type Material = {
  readonly runes: ReadonlyMap<number, readonly string[]>;
  readonly grams: ReadonlyMap<number, ReadonlyMap<string, number>>;
  readonly byGram: ReadonlyMap<string, readonly Posting[]>;
};

/**
 * **求めた長さに届きうる相手だけ**を返す。
 *
 * **落としてよいのは、そこに届かないものだけ**である（#653 のレビュー 2 周目）
 * ——**「いちばん近い 1 本」を先に選ばない。**
 *
 * **索引から引く** (#656)——**相手を 1 本ずつ全部見ると、本数の 2 乗**である。
 * **共通する並びを 1 つも持たない相手は、そもそも出てこない。**
 */
function* reachable(
  number: number,
  atLeast: number,
  material: Material,
  screening: { left: number; spent: boolean },
): Generator<number> {
  const floor = atLeast - 1;
  if (floor <= 0) {
    // **0 個の共有でも届く**——**索引に出てこない相手も落とせない**
    yield* everyOther(number, material.runes);
    return;
  }

  const shared = sharedCounts(number, material, screening);
  for (const [other, count] of shared) {
    if (count >= floor && (material.runes.get(other)?.length ?? 0) > 0) {
      yield other;
    }
  }
}

function* everyOther(
  number: number,
  runes: ReadonlyMap<number, readonly string[]>,
): Generator<number> {
  for (const [other, rune] of runes) {
    if (other !== number && rune.length > 0) {
      yield other;
    }
  }
}

/**
 * **相手ごとの、共通する 2 文字の並びの出現数**（少ないほうを取った合計）。
 *
 * **索引を引いて、出てきた相手だけ数える**——**出てこない相手は 0 個**である。
 */
function sharedCounts(
  number: number,
  material: Material,
  screening: { left: number; spent: boolean },
): ReadonlyMap<number, number> {
  const counts = new Map<number, number>();
  const ownGrams = material.grams.get(number) ?? new Map<string, number>();
  for (const [gram, times] of ownGrams) {
    for (const posting of material.byGram.get(gram) ?? []) {
      if (screening.left <= 0) {
        // **区切ったことは `partial` で言う**——**黙って切らない**
        screening.spent = true;
        return counts;
      }
      screening.left -= 1;
      if (posting.number !== number) {
        const shared = Math.min(times, posting.times);
        counts.set(posting.number, (counts.get(posting.number) ?? 0) + shared);
      }
    }
  }
  return counts;
}

/**
 * **2 つのタイトルに共通する、いちばん長い並び**（書記素の配列）。
 *
 * **符号単位ではない**（#653 のレビュー 3 周目）——**絵文字 1 個を 2 と数えると、
 * 短い一致が選ばれて長いほうを取りこぼす**うえ、**切り出しが上位サロゲートで
 * 切れて壊れた文字列が出る。**
 *
 * **前の行だけを持って進む**——**長さの 2 乗の表を全部持たない。**
 */
function longestShared(left: readonly string[], right: readonly string[]): readonly string[] {
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
