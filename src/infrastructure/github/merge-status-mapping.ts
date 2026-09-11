/**
 * GitHub の GraphQL 応答から、**合流の状況**をドメイン型へ移す（#629）。
 *
 * **境界の仕事は 2 つだけ。** 応答を Zod で検証することと、ドメインの型へ移すこと。
 * **通信はここに置かない**（`pull-request-mapping.ts` と同じ形）——**純粋関数のままなら、
 * 実際の応答を貼った試験で外部 I/O 無しに確かめられる。**
 *
 * **REST ではなく GraphQL なのは、一覧に `mergeable` が無いから**である。
 * **`GET /repos/{owner}/{repo}/pulls` は返さず**、**1 件ずつの
 * `GET /pulls/{number}` にしか無い**——**PR の本数ぶん往復することになる。**
 *
 * **知らない値は「マージできる」へ倒さない。** **GitHub が値を増やした日に、
 * 押せない PR が「問題なし」の顔で並ぶ**（#540 / #541 と同じ向き）。
 */

import { z } from "zod";
import type { Mergeable, MergeState, MergeStatusReport } from "../../domain/graph/merge-readiness";
import type { ReviewOpinion } from "../../domain/triage/ball";

const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });

/**
 * 使う項目だけを検証する。
 *
 * **`errors` が載っていたら読まない**（#346 のレビュー 2 周目）。**GraphQL は 200 の
 * まま失敗を返す**ので、**状態コードだけを見ると「conflict していない」として通る。**
 * **`z.never().optional()` は「無いときだけ通る」。**
 */
const pageSchema = z.object({
  errors: z.never().optional(),
  data: z.object({
    repository: z.object({
      pullRequests: z.object({
        pageInfo: pageInfoSchema,
        // **1 件ずつ後から検証する**（`toPullRequestRefs` と同じ形）——
        // **1 件の形が違うだけで、盤面全部の状況を捨てない**
        nodes: z.array(z.unknown()),
      }),
    }),
  }),
});

const nodeSchema = z.object({
  number: z.number().int().positive(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
});

/**
 * レビューの意見（#636）。**合流の状況とは別に検証する。**
 *
 * **1 件の形が違うだけで、その PR の合流の状況まで捨てない**（このファイルの判断）
 * ——**別の関心**なので、**別に読む。**
 *
 * **`commit` は `null` になりうる**（**force push で消えた commit の意見**）。
 * **`hasNextPage` なら意見を出さない**——**見えたぶんに変更の求めが無くても、
 * 次のページにあるかは分からない**（`AGENTS.md` §5）。
 */
const opinionSchema = z.object({
  number: z.number().int().positive(),
  headRefOid: z.string().min(1),
  reviews: z.object({ totalCount: z.number().int().nonnegative() }),
  latestOpinionatedReviews: z.object({
    pageInfo: z.object({ hasNextPage: z.boolean() }),
    nodes: z.array(
      z.object({
        state: z.string(),
        commit: z.object({ oid: z.string() }).nullable(),
      }),
    ),
  }),
});

/** 意見と、**それを判定した commit**（#652 のレビュー）。 */
export type JudgedOpinion = {
  readonly head: string;
  readonly opinion: ReviewOpinion;
};

/** 読み取った 1 ページ。 */
export type MergeStatusPage = {
  readonly statuses: ReadonlyMap<number, MergeStatusReport>;
  /**
   * PR 番号から引けるレビューの意見（#636）。
   *
   * **判定した commit を一緒に返す**（#652 のレビュー）——**この応答と、REST の
   * 一覧は同時に走る**ので、**その間に push されると 2 つが別の commit を見る。**
   * **番号だけで結合すると、誰も読んでいない commit に「承認済み」が付く**
   * （#331 / #635 / #643 と同じ形）。**突き合わせるのは呼ぶ側**である。
   *
   * **読めなかった PR は入らない**（`statuses` と同じ）——**`ballOf` が
   * 地図に無い番号を `unknown` へ倒す**ので、**「読めなかった」が「放置」に化けない。**
   */
  readonly opinions: ReadonlyMap<number, JudgedOpinion>;
  /** 次のページの位置。**続きが無ければ `undefined`。** */
  readonly nextCursor: string | undefined;
};

/**
 * 応答をドメインの型へ移す。
 *
 * **一覧そのものが読めなければ落とす**（`toPullRequestRefs` と同じ）。**空の地図を
 * 返すと、取得の失敗が「どの PR も conflict していない」に化ける。**
 *
 * **1 件ずつの失敗は別**である。**その PR の状況が「分からない」になるだけ**で、
 * **`mergeReadinessOf` は地図に無い番号を `unknown` へ倒す**——**黙って
 * 「マージできる」にはならない。**
 */
/**
 * **1 件の node から、合流の状況を読む**（#681）。
 *
 * **横断の口とも共有する**——**`mergeable` / `mergeStateStatus` をドメインの語へ
 * 移す規則を 2 箇所に持たない**（`AGENTS.md` §5）。**読めなければ `undefined`**
 * ——**「マージできる」へ倒さない。**
 */
export function mergeStatusOf(
  item: unknown,
): { readonly number: number; readonly status: MergeStatusReport } | undefined {
  const node = nodeSchema.safeParse(item);
  if (!node.success) {
    return undefined;
  }
  return {
    number: node.data.number,
    status: {
      mergeable: toMergeable(node.data.mergeable),
      state: toMergeState(node.data.mergeStateStatus),
    },
  };
}

/**
 * **1 件の node から、意見と、それを判定した commit を読む**（#681）。
 *
 * **横断の口とも共有する**（`mergeStatusOf` と同じ理由）。
 * **最後まで読めていなければ `undefined`**——**「放置」へ倒さない。**
 */
export function judgedOpinionOf(
  item: unknown,
): { readonly number: number; readonly judged: JudgedOpinion } | undefined {
  const opinion = opinionSchema.safeParse(item);
  if (!opinion.success) {
    return undefined;
  }
  const seen = toReviewOpinion(opinion.data);
  return seen === undefined
    ? undefined
    : { number: opinion.data.number, judged: { head: opinion.data.headRefOid, opinion: seen } };
}

export function toMergeStatusPage(response: unknown): MergeStatusPage {
  const parsed = pageSchema.safeParse(response);
  if (!parsed.success) {
    throw new Error(`合流の状況として読めません: ${z.prettifyError(parsed.error)}`);
  }
  const { pageInfo, nodes } = parsed.data.data.repository.pullRequests;

  const statuses = new Map<number, MergeStatusReport>();
  const opinions = new Map<number, JudgedOpinion>();
  for (const item of nodes) {
    const status = mergeStatusOf(item);
    if (status !== undefined) {
      statuses.set(status.number, status.status);
    }
    // **意見は別に読む**——**合流の状況が読めた PR でも、意見だけ読めないことがある**
    const opinion = judgedOpinionOf(item);
    if (opinion !== undefined) {
      opinions.set(opinion.number, opinion.judged);
    }
  }
  return { statuses, opinions, nextCursor: nextCursor(pageInfo) };
}

/**
 * 次のページの位置。**続きがあると言いながら行き先が無いなら、読めていない。**
 *
 * **黙って止めない**（#346 のレビュー 2 周目）——**残りのページの PR は
 * 「一覧に無い」へ落ちる。** **読めていないだけである。**
 */
function nextCursor(pageInfo: z.infer<typeof pageInfoSchema>): string | undefined {
  if (!pageInfo.hasNextPage) {
    return undefined;
  }
  if (pageInfo.endCursor === null) {
    throw new Error("合流の状況に続きがありますが、次の位置が読めません");
  }
  return pageInfo.endCursor;
}

/** GitHub の `MergeableState`。**知らない値は `unknown` へ寄せる。** */
function toMergeable(value: string): Mergeable {
  switch (value) {
    case "MERGEABLE":
      return "mergeable";
    case "CONFLICTING":
      return "conflicting";
    default:
      return "unknown";
  }
}

/** GitHub の `MergeStateStatus`。**知らない値は `unknown` へ寄せる。** */
function toMergeState(value: string): MergeState {
  switch (value) {
    case "BEHIND":
      return "behind";
    case "BLOCKED":
      return "blocked";
    case "CLEAN":
      return "clean";
    case "DIRTY":
      return "dirty";
    case "DRAFT":
      return "draft";
    case "HAS_HOOKS":
      return "has-hooks";
    case "UNSTABLE":
      return "unstable";
    default:
      return "unknown";
  }
}

/**
 * **base に何コミット遅れているか**を読む（#639）。
 *
 * **`mergeStateStatus` とは別の口である。** **compare が `behindBy` をそのまま返す**
 * ので、**`BEHIND` が返らない設定でも数は出る**（#644 のレビュー）。
 *
 * **読めなければ `undefined`。** **`0` へ倒さない**——**既定の分岐に落とすと、
 * 黙って「遅れていません」になる**（`AGENTS.md` §5。**このリポジトリが 7 回塞いだ形**）。
 *
 * **`ref` は `null` になりうる**（**base の枝が消えている**）。**`compare` も
 * `null` になりうる**（**head を解決できない**——**fork の PR でありうる**）。
 */
const behindBySchema = z.object({
  // **`errors` が載っていたら読まない**（`pageSchema` と同じ）
  errors: z.never().optional(),
  data: z.object({
    repository: z.object({
      ref: z
        .object({ compare: z.object({ behindBy: z.number().int().nonnegative() }).nullable() })
        .nullable(),
    }),
  }),
});

export function toBehindBy(response: unknown): number | undefined {
  const parsed = behindBySchema.safeParse(response);
  return parsed.success ? parsed.data.data.repository.ref?.compare?.behindBy : undefined;
}

/**
 * 意見をドメインの型へ移す。**最後まで読めていなければ `undefined`。**
 *
 * **`reviewed` は `reviews.totalCount` から取る**（#636 の罠）——**意見を持たない
 * レビュー（`COMMENTED`）も提出されたもの**である。**実測（2026-09-08、PR #650）:
 * `totalCount` が 6 で `latestOpinionatedReviews` は 0 件**だった。
 *
 * **`state` は最新の意見だけが並ぶ**（`latestOpinionatedReviews`）ので、
 * **取り下げられた承認も、あとから変更を求めた人の古い承認も入らない**
 * ——**その規則は GitHub が持つ**（`AGENTS.md` §5）。
 */
function toReviewOpinion(node: z.infer<typeof opinionSchema>): ReviewOpinion | undefined {
  if (node.latestOpinionatedReviews.pageInfo.hasNextPage) {
    return undefined;
  }
  const onHead = (state: string) =>
    node.latestOpinionatedReviews.nodes.some(
      (review) => review.state === state && review.commit?.oid === node.headRefOid,
    );
  return {
    approvesHead: onHead("APPROVED"),
    changesRequestedOnHead: onHead("CHANGES_REQUESTED"),
    reviewed: node.reviews.totalCount > 0,
  };
}
