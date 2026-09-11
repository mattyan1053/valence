/**
 * **見えるリポジトリを跨いで、open な PR を引く口**（#662）。
 *
 * **1 リポジトリの盤面を N 枚重ねない。** **実測（2026-09-11、50 リポジトリ）**:
 * **盤面 1 枚は「PR 1 本あたり 3 往復を順に」が律速**（#669）で、**固定費も 2 往復**
 * ——**50 件ぶんを順に作ると往復だけで 100 回を超え**、**1 往復 1.3 秒なら 2 分**である
 * （**`CHANGES_DEADLINE_MS = 20_000` の 6 倍**）。**別名で 1 要求にまとめると
 * 約 3.0〜3.4 秒**だった。
 *
 * **往復はリポジトリ数に依らない**——**`bin/loop-*` が「番号引きは open 数に依らない」
 * ために採っているのと同じ形**である。
 *
 * **ファイル変更に依るものは、ここでは扱わない。** **Tier（#314）と、
 * 同じファイルを触る組（#637）は「PR 1 本あたり 3 往復」の側**であり、
 * **横断で出すと 41 本で 2 分になる。** **リポジトリの盤面に残す。**
 *
 * **依存グラフは跨がない**（#662 の本文）——**base/head は同じリポジトリの中の話**で、
 * **跨いだ線を引かない。** **この口は辺を作る材料を返さない**ので、
 * **跨ぐほうが難しい形**にしてある。
 *
 * **ユーザートークンで引く**（`AGENTS.md` §6）——**見えるリポジトリだけを渡す**のは
 * 呼ぶ側であり、**installation トークンで代用しない**（**誰がログインしていても
 * 同じものが見えてしまう**）。
 */

import type { MergeStatusReport } from "../../domain/graph/merge-readiness";
import type { Assignment } from "../../domain/triage/assignment";
import type { ReviewOpinion } from "../../domain/triage/ball";
import type { VisibleRepository } from "./visible-repositories";

/** 横断の一覧に出す 1 本。**リポジトリを跨ぐので、番号だけでは指せない。** */
export type CrossRepositoryPullRequest = {
  /** どのリポジトリのものか。**番号と対で、はじめて 1 本を指せる。** */
  readonly repository: VisibleRepository;
  readonly number: number;
  /**
   * タイトル。
   *
   * **読めなかった PR は入らない**（`invalid` へ回す）——**空文字を入れない。**
   * **入れると、表示の側で「短いタイトル」と「取れなかった」が見分けられない**
   * （`PullRequestListing.titles` と同じ判断）。
   */
  readonly title: string;
  /** 最後に動いた時刻（ISO 8601）。**並べる材料**である。 */
  readonly updatedAt: string;
  /**
   * いま盤面が見せている head の commit（#331）。
   *
   * **押した対象を、見せた対象に固定する**ために運ぶ。**読めなければ入らない。**
   */
  readonly head?: string;
  /**
   * 合流の状況（#629）。**押せない理由を、押す前に言う材料**である。
   *
   * **読めなかった PR は持たない**——**`mergeReadinessOf` が「分からない」へ倒す**ので、
   * **「マージできる」に化けない**（`PullRequestListing.mergeStatuses` と同じ判断）。
   */
  readonly mergeStatus?: MergeStatusReport;
  /**
   * レビューの意見（#636）。**誰の番かを決める材料**である。
   *
   * **読めなかった PR は持たない**——**`ballOf` が「分からない」へ倒す**ので、
   * **「放置」に化けない。**
   */
  readonly opinion?: ReviewOpinion;
  /**
   * 誰に振られているか（#631）。
   *
   * **読めなかった PR は持たない**——**「誰も持っていない」に化けない。**
   */
  readonly assignment?: Assignment;
};

/**
 * **答えが返らなかったリポジトリ**（#662 の「1 つが読めなくても、他を出す」）。
 *
 * **1 つ落ちたら全部出さない、にしない。** **ただし「読めなかった」は残す**
 * ——**黙ると、盤面は静かに不完全になる。**
 *
 * **実測**: **読めないリポジトリを混ぜた要求は、読めたものを返し、
 * 読めなかったものだけが `null` + `errors[].path`** で返る。
 * **`errors` を読み落とすと、`null` が「PR が 0 本」に化ける。**
 */
export type UnavailableRepository = {
  readonly repository: VisibleRepository;
  /**
   * **何が起きたか。**
   *
   * - `unreadable` —— **答えが返らなかった**（見えない / 落ちている）
   * - `truncated` —— **多すぎて読み切れなかった**（**読めたぶんは一覧に入っている**）
   *
   * **2 つを分ける**——**前者は 1 本も出ていない**が、**後者は「一部だけ出ている」**
   * である。**混ぜると、読む側が「全部無い」と読む。**
   */
  readonly kind: "unreadable" | "truncated";
};

/** 検証に落ちた 1 件。**`PullRequestListing.invalid` と同じ形**である。 */
export type InvalidCrossRepositoryPullRequest = {
  /** どのリポジトリの応答か。**番号が読めないことがある**ので、位置ではなく箱を示す。 */
  readonly repository: VisibleRepository;
  /** 応答の何件目か（0 始まり）。 */
  readonly index: number;
  /** 何が読めなかったか。**応答の中身は載せない**（§6）。 */
  readonly reason: string;
};

export type CrossRepositoryListing = {
  /** 読めた PR。**リポジトリを跨いで並ぶ。** */
  readonly pullRequests: readonly CrossRepositoryPullRequest[];
  /** **答えが返らなかった / 読み切れなかったリポジトリ。** */
  readonly unavailable: readonly UnavailableRepository[];
  /** 形が読めなかった PR。**黙って捨てない。** */
  readonly invalid: readonly InvalidCrossRepositoryPullRequest[];
};

export type CrossRepositoryRequest = {
  /**
   * 打ち切りの合図（`ChangeSummaryRequest` / `PullRequestApprovalRequest` と同じ形）。
   *
   * **先に返すだけでは、走っている要求は走り続ける。** **期限の決め方はここに無い**
   * ——**どれだけ待つかは呼ぶ側の段取り**である（`application` は時計を持たない）。
   */
  readonly signal?: AbortSignal;
};

export type CrossRepositoryPullRequests = {
  /**
   * **その人の身元で**、渡されたリポジトリの open な PR を引く。
   *
   * **まとめて引く。** **リポジトリごとに往復しない**（上記）——**実測（2026-09-11）**:
   * **1 要求に並べられるのは 25 件まで**（**それ以上は
   * `MAX_NODE_LIMIT_EXCEEDED`。50 件・PR 100 本・意見 100 件で 555,000 > 500,000**）。
   * **50 件は 2 要求で、並べて投げて 4.0〜4.4 秒**（**順に投げると 6.4〜7.2 秒**）。
   * **往復は「リポジトリ数 ÷ 25」**であり、**盤面を N 枚重ねる形の 1/50 以下**である。
   *
   * **応答そのものが読めなければ投げる。** **空の一覧を返すと、「読めなかった」が
   * 「1 本も open PR が無い」に化ける。** **1 つずつ読めなかったぶんは
   * `unavailable` に残して返る**——**そこは「全部出さない」にしない側**である。
   *
   * **渡すのは、見えると分かっているリポジトリだけ**（§6）。
   */
  list(
    userAccessToken: string,
    repositories: readonly VisibleRepository[],
    request?: CrossRepositoryRequest,
  ): Promise<CrossRepositoryListing>;
};
