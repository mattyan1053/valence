/**
 * 1 つのリポジトリの盤面——**依存グラフとリスク Tier を出す**（#314）。
 *
 * **infrastructure を直に触らない**（§3）。**合成ルートだけを呼ぶ。**
 *
 * **見られないリポジトリは 404 へ倒す。** **「権限がありません」と「ありません」を
 * 区別できる応答にしない**（§6）——**分けた瞬間に、見えないほうの存在を教える。**
 * **判定は `viewRepositoryBoard` が持っている**ので、**ここには書き写さない。**
 */

import { notFound } from "next/navigation";
import { unavailableReason } from "../../../../application/observability/unavailable-reason";
import type { IssueListing } from "../../../../application/ports/issue-source";
import type { PullRequestApprovalListing } from "../../../../application/ports/pull-request-approvals";
import type {
  IssuesUnavailable,
  RepositoryBoardResult,
} from "../../../../application/review-order/view-repository-board";
import {
  issuePageUrl,
  pullRequestPageUrl,
  reportBoardActionUnavailable,
  repositoryBoardForCurrentUser,
} from "../../../../composition/auth";
import type { MergeBlock, NotOrderableReason } from "../../../../domain/graph/merge-block";
import { mergeBlocksFor } from "../../../../domain/graph/merge-block";
import type { ApprovalDisplayKind } from "../../../../ui/approve/approval-badge";
import { ApprovalBadge } from "../../../../ui/approve/approval-badge";
import type { ApproveNoticeKind } from "../../../../ui/approve/approve-button";
import { ApproveButton, approveNotice } from "../../../../ui/approve/approve-button";
import { AssignmentSummaryView } from "../../../../ui/assignment/assignment-summary-view";
import { SignOutButton, showsSignOut } from "../../../../ui/auth/sign-out-button";
import { BALL_FILTERS } from "../../../../ui/ball/ball-filter";
import { BoardFreshness } from "../../../../ui/board/board-freshness";
import { boardReloadHref } from "../../../../ui/board/board-reload-href";
import type { IssueBoardProps } from "../../../../ui/issue-board/issue-board";
import { IssueBoard } from "../../../../ui/issue-board/issue-board";
import type { MergeNoticeKind } from "../../../../ui/merge/merge-button";
import { MergeButton, mergeNotice } from "../../../../ui/merge/merge-button";
import type { MergePlanNoticeKind } from "../../../../ui/merge/merge-plan-button";
import {
  MergePlanButton,
  mergePlanNotice,
  mergePlanSteps,
} from "../../../../ui/merge/merge-plan-button";
import { ReviewBoard } from "../../../../ui/review-board/review-board";
import { SuggestedReviewOrder } from "../../../../ui/review-order/suggested-review-order";
import { allowedValueFrom, pullRequestNumberFrom } from "../../../query-input";

/**
 * **要求ごとに描く。静的に生成させない**（入口の画面と同じ理由）。
 *
 * **出すのは「いまログインしている人に何が見えるか」**である——**ビルドした瞬間の
 * 状態を焼き付けたら、全テナントに同じものが出る**（`AGENTS.md` §1 の
 * 「実行時に解決する。設定に固定しない」の逆）。
 */
export const dynamic = "force-dynamic";

/**
 * 読めなかった PR の注記。**件数だけを出す**（入口の画面と同じ理由）。
 *
 * **理由は画面へ出さない**——**Zod のメッセージには値が入りうる。**
 */
export function unreadableNote(count: number): string | undefined {
  return count === 0 ? undefined : `${count} 件の PR は読めませんでした。図には抜けがあります。`;
}

/** 出せなかったときの案内。**行き先が違うので、文面も分ける。** */
function notice(kind: "signed-out" | "needs-login" | "unavailable"): string {
  switch (kind) {
    case "signed-out":
      return "GitHub でログインすると、このリポジトリのレビュー状況が見られます。";
    case "needs-login":
      return "ログインの期限が切れました。入り直してください。";
    case "unavailable":
      // **入り直しても直らない。** **再ログインへ案内すると、故障を認証切れとして隠す**
      return "いま取得できませんでした。しばらくしてから読み込み直してください。";
  }
}

/**
 * 直前に**押せなかった**理由。**知らない値は出さない**（#330）。
 *
 * **`?approve=` は URL に載っている**ので、**誰でも好きな文字列を入れられる**
 * ——**そのまま画面へ出すと、こちらが言っていないことを言わせられる。**
 * **並べたものだけを通す**（#90 と同じ形）。
 *
 * **成功はここから出さない**（#342 のレビュー）——**`?approve=approved` を
 * 開くだけで「承認しました」と出てはならない。** **承認できたかどうかは、
 * 利用者が任意に作れない場所（GitHub 側の状態）で確かめる。**
 */
const APPROVE_NOTICE_KINDS = ["forbidden", "self-approval", "unavailable"] as const;

export function approveNoticeKind(value: unknown): ApproveNoticeKind | undefined {
  return allowedValueFrom(value, APPROVE_NOTICE_KINDS);
}

/**
 * 直前に**マージできなかった**理由。**知らない値は出さない**（#331）。
 *
 * **成功はここから出さない**（#342 のレビューと同じ）——**`?merge=merged` を
 * 開くだけで「マージしました」と出てはならない。**
 */
const MERGE_NOTICE_KINDS = [
  "forbidden",
  "not-mergeable",
  "dependency-pending",
  "not-orderable",
  "base-changed",
  "unavailable",
] as const;

export function mergeNoticeKind(value: unknown): MergeNoticeKind | undefined {
  return allowedValueFrom(value, MERGE_NOTICE_KINDS);
}

/**
 * その PR について、盤面に出す状態（#343）。
 *
 * **「承認済み」は、いま見せている head を承認済みという意味である**（#635）
 * ——**突き合わせは `viewRepositoryBoard` と `PullRequestApprovals` が済ませている**
 * ので、**ここは引くだけ**である（**判定を 2 箇所に持たない**）。
 *
 * **読むのは GitHub から引いた状態だけ**である——**引数に検索文字列が無い**ので、
 * **`?approve=approved` のような値からは作れない**（#342 が塞いだ穴）。
 *
 * **「承認されていない」は出さない**（`ApprovalBadge` の理由）。
 * **読めなかったことは出す**——**黙らせると、承認されていないのと見分けが付かない。**
 *
 * **理由は画面へ出さない**（`unreadableNote` と同じ理由。**値が入りうる**）。
 */
export function approvalDisplay(
  pullRequestNumber: number,
  approvals: PullRequestApprovalListing,
): ApprovalDisplayKind | undefined {
  if (approvals.approved.has(pullRequestNumber)) {
    return "approved";
  }
  return approvals.unavailable.some((row) => row.pullRequestNumber === pullRequestNumber)
    ? "unknown"
    : undefined;
}

/**
 * **その番号の判定が地図に無いとき**（#702）。
 *
 * **一覧に出てこないのと同じ扱い**である——**知らない番号を「マージしてよい」と
 * 言わない**（`blockFrom` の最後の行と同じ判断）。**行ごとの事実**なので、
 * **断りはその行に出る。**
 */
const MISSING_BLOCK = { kind: "not-orderable", reason: "not-listed" } as const;

/**
 * 依存の判定を、ボタンが受け取る形へ直す（#345）。
 *
 * **判定そのものは `mergeBlockFor` が持つ**——**ここは詰め替えるだけ**である
 * （**POST の口も同じ関数を通る**ので、**画面と食い違わない**）。
 */
export function mergeButtonBlock(block: MergeBlock): {
  readonly blockedBy?: readonly number[];
  readonly notOrderable?: NotOrderableReason;
} {
  switch (block.kind) {
    case "depends-on":
      return { blockedBy: block.numbers };
    case "not-orderable":
      // **理由をそのまま運ぶ**（#702）——**どこに断りを出すかは、受け取った側が
      // `isBoardWide` で決める**（**ここで真偽値に潰すと、盤面の事実か行の事実かが
      // 消える**）
      return { notOrderable: block.reason };
    case "ready":
      return {};
  }
}

/**
 * **盤面を組み立てるまで** (#519)。
 *
 * **受け口を引数で渡す**——**画面から呼ぶと composition が本物を掴む**ので、
 * **「記録の口を呼んでいること」を試験から見られない**（**#513 のレビューで
 * 1 度戻し、そのときは見送った穴**——**呼び出しを消しても部品の試験は緑だった**）。
 * **モックは使わない**（`AGENTS.md` §4）——**インメモリの実装を渡す形にする。**
 *
 * **判定は `unavailableReason` のまま 1 箇所である**（§5。#690 で `application` へ移した）。
 */
/**
 * issue の一覧を、画面へ渡せる形にする（#633）。
 *
 * **取れなかったことを、空の一覧と混ぜない**——**混ぜると、取れなかった日に
 * 「issue はありません」と出る**（`AGENTS.md` §5）。**理由の種別はそのまま運ぶ**
 * （#573。**「読めなかった」と「待たなかった」を同じ文にしない**）。
 */
export function issueBoardProps(
  listing: IssueListing | IssuesUnavailable,
): Omit<IssueBoardProps, "urlOf"> {
  if ("unavailable" in listing) {
    return { issues: listing, assignments: new Map(), unreadable: 0 };
  }
  return {
    issues: listing.issues,
    assignments: listing.assignments,
    // **読めなかったぶんを黙って落とさない**
    unreadable: listing.invalid.length,
  };
}

/**
 * 流すプランの結果（#661）。**URL から渡ってくる値**なので、**語彙に無いものは捨てる**
 * ——**`mergeNoticeKind` と同じ形**である（**成功は語彙に無い**）。
 */
const PLAN_NOTICE_KINDS: readonly MergePlanNoticeKind[] = [
  "not-approved",
  "not-mergeable",
  "dependency-pending",
  "base-changed",
  "not-orderable",
  "forbidden",
  "nothing-to-run",
  "unavailable",
];

export function planNoticeKind(value: unknown): MergePlanNoticeKind | undefined {
  return allowedValueFrom(value, PLAN_NOTICE_KINDS);
}

/**
 * 止まった PR の番号（#661）。**URL から渡ってくる**ので、**形で絞る。**
 *
 * **これは「入らなかった」の側**である——**入った本数は URL から出さない**
 * （**流していない人が「N 本入りました」と出せる**。#342 のレビュー）。
 */
export function planStoppedAt(value: unknown): number | undefined {
  // **同じ判定を 3 つ目に書かない**（§5）——**`approve` / `merge` の受け口が
  // 同じものを持っていた**ので、**受け口ごと 1 箇所へ寄せた**（#696）
  return pullRequestNumberFrom(value);
}

/**
 * 盤面に出す注記（#661 のレビューで 3 つ目が増えた）。
 *
 * **どれも「押せなかった理由」**である（**成功は語彙に無い**。#342 のレビュー）。
 * **判定をここへ集める**——**描く側は並べるだけ**にする。
 */
/**
 * **「さっき押した結果」の断りが載る鍵**（#664 のレビュー 2 周目）。
 *
 * **下の `boardNotices` が読む鍵と、同じ集合**である——**断りを 1 つ増やすなら、
 * ここにも足す。** **引き直す先（`boardReloadHref`）はこれを落とす**
 * ——**持ち越すと、押していないのに同じ断りがもう一度出る。**
 *
 * **読む側の隣に置く。** **離した結果、`?plan=` が足された日に片方だけが古くなった**
 * （`AGENTS.md` §5）。
 */
export const BOARD_OUTCOME_KEYS: readonly string[] = ["approve", "merge", "plan", "plan-at"];

export function boardNotices(
  query: Record<string, string | string[] | undefined>,
): readonly string[] {
  const approve = approveNoticeKind(query.approve);
  const merge = mergeNoticeKind(query.merge);
  const plan = planNoticeKind(query.plan);
  return [
    approve === undefined ? undefined : approveNotice(approve),
    merge === undefined ? undefined : mergeNotice(merge),
    plan === undefined ? undefined : mergePlanNotice(plan, planStoppedAt(query["plan-at"])),
  ].filter((line): line is string => line !== undefined);
}

export type BoardPageDeps = {
  /** 盤面を引く口（`repositoryBoardForCurrentUser`）。 */
  readonly board: (repository: {
    readonly owner: string;
    readonly name: string;
  }) => Promise<RepositoryBoardResult>;
  /** 出せなかった理由を残す口（`reportBoardActionUnavailable`）。 */
  readonly report: (action: "view", kind: string) => void;
  /**
   * **いま何時か**（#664）。**盤面を取った時刻として出す。**
   *
   * **時計は外から受ける**（§3）——**画面の中で `new Date()` を呼ぶと、
   * 何時のものを描いたかを試験から決められない。**
   *
   * **既定を持つ。** **渡し忘れても、出るのは本物の時刻**である
   * ——**倒れる先が「その要求の時刻」なので、嘘にならない。**
   */
  readonly now?: () => Date;
};

/**
 * **材料が出せなかったことを、サーバ側に残す** (#573)。
 *
 * **画面は「まだ取得できていません」としか言えない**（**`reason` には応答の値が
 * 入りうる**。`AGENTS.md` §6）ので、**どれだったかはここにしか残らない。**
 *
 * **`kind` ごとに 1 行**である——**PR の本数ぶん出すと、毎回鳴る記録になる**（#248）。
 *
 * **これが無いと、#573 の「最初の一手」が空振りする**——**記録を読んで決める、と
 * 書いてあるのに、記録が 1 行も出ていなかった**（**実測: 期限 5000 ms に対して
 * 取得は 5627 ms。毎回打ち切られていた**）。
 */
/** **既定の時計**（#664）。**渡し忘れても、出るのは本物の時刻**である。 */
function systemClock(): Date {
  return new Date();
}

function reportMissingChanges(
  unavailable: readonly { readonly kind: string }[],
  report: BoardPageDeps["report"],
): void {
  for (const kind of new Set(unavailable.map((entry) => entry.kind))) {
    report("view", `changes/${kind}`);
  }
}

export async function renderRepositoryBoard(
  { owner, name }: { readonly owner: string; readonly name: string },
  query: Record<string, string | string[] | undefined>,
  deps: BoardPageDeps,
) {
  const notices = boardNotices(query);
  // **絞ったまま操作を続けられるようにする**（#667）——**押す本文へ載せて運ぶ**ので、
  // **戻り先でも同じ絞りが効く。** **知らない値は「絞らない」へ落ちる**
  // （**絞ること自体は #663 が持つ**——**どちらが先に入っても壊れない**）
  const ball = allowedValueFrom(query.ball, BALL_FILTERS);
  // **取りに行く前に読む**（#664）——**取れた時刻ではなく、取りに行った時刻**である。
  // **どちらでも「この時刻より前のもの」**で、**先に読むほうが、遅い日に
  // 実際より新しく見えることが無い**
  const { now = systemClock } = deps;
  const at = now();
  const result = await deps.board({ owner, name });
  // **落ちどころを、サーバ側に残す** (#513 のレビュー)——**押した経路と同じ**
  const unavailable = unavailableReason(result);
  if (unavailable !== undefined) {
    deps.report("view", unavailable);
  }

  if (result.kind === "board") {
    reportMissingChanges(result.plan.changesUnavailable, deps.report);
  }

  if (result.kind === "not-found") {
    // **存在も漏らさない。** **見えない人には、無いのと同じに見える**
    notFound();
  }

  // **行ごとに判定を呼ばない**（#541 のレビュー）——**呼ぶたびに辺と順序をなめ直す**ので、
  // **本数の 2 乗**になる。**判定は変わらない**（**`mergeBlocksFor` は `mergeBlockFor` と
  // 同じ規則を、索引を 1 度だけ作って配る**）。
  const blocks =
    result.kind === "board"
      ? mergeBlocksFor(
          result.plan.pullRequests.map((pullRequest) => pullRequest.number),
          result.plan.edges,
          result.plan.order,
          result.plan.invalid.length,
        )
      : undefined;

  return (
    <main className="mx-auto flex max-w-4xl flex-1 flex-col gap-4 px-6 py-12">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-mono text-2xl font-bold tracking-tight">
          {owner}/{name}
        </h1>
        {/* **期限が切れた盤面からも出られること**（#563）——**「入り直してください」
            と言う画面に、いまのセッションを捨てる手が無かった。**
            **判定は `showsSignOut` が持つ**（入口の画面と 2 箇所に置かない） */}
        {showsSignOut(result.kind) ? <SignOutButton action="/auth/logout" /> : undefined}
      </div>
      {/* **押せなかった理由は、押した画面に出す**（判定は `boardNotices` が持つ） */}
      {notices.map((line) => (
        <p className="text-sm" key={line}>
          {line}
        </p>
      ))}
      {result.kind === "board" ? (
        <>
          {/* **いつ取ったものかと、引き直す手**（#664）——**盤面は開いた瞬間の
              スナップショット**で、**開いたまま置いておくと古くなる。**
              **出せなかったときは出さない**——**盤面が無いのに時刻だけ出ると、
              何かが取れたように見える**（§5） */}
          <BoardFreshness at={at} reloadHref={boardReloadHref(query, BOARD_OUTCOME_KEYS)} />
          {/* **何件が誰にも振られていないかを出す**（#631）——**数えるのは domain が
              持つ**（`summarizeAssignments`）。**言うことが無ければ、この行は出ない** */}
          <AssignmentSummaryView
            pullRequestNumbers={result.plan.pullRequests.map((pullRequest) => pullRequest.number)}
            assignments={result.plan.assignments}
          />
          {/* **どれから見るかを、盤面とは別に出す**（#632）——**一覧は依存の順のまま**
              である。**混ぜて 1 つの並びにすると、土台より先に積み荷をマージしようとする**
              （`review-board.tsx` の判断）。**並べ替えは domain が持つ**——
              **ここは材料を渡すだけ**である */}
          {/* **順序はもう出ている**（#661）——**流すのだけが手作業**だった。
           **1 本ずつ押す道は残す**（行の `MergeButton`）。
           **commit が分からない PR は並びに入らない**（#331） */}
          <MergePlanButton
            action={`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/merge-plan`}
            ball={ball}
            steps={mergePlanSteps(result.plan.order, (number) => result.plan.heads.get(number))}
          />
          <SuggestedReviewOrder
            pullRequests={result.plan.pullRequests}
            order={result.plan.order}
            changes={result.plan.changes}
            mergeStatusOf={(number) => result.plan.mergeStatuses.get(number)}
            titleOf={(number) => result.plan.titles.get(number)}
            urlOf={(number) => pullRequestPageUrl({ owner, name }, number)}
          />
          <ReviewBoard
            pullRequests={result.plan.pullRequests}
            edges={result.plan.edges}
            order={result.plan.order}
            invalid={result.plan.invalid}
            changes={result.plan.changes}
            // **なぜ出せなかったかを、行に出す** (#573)——**`kind` だけを渡す**
            // （**`reason` は画面へ出さない**。§6）
            changeUnavailableOf={(number) =>
              result.plan.changesUnavailable.find((entry) => entry.pullRequestNumber === number)
                ?.kind
            }
            // **図の札を、ボタンと同じ条件にする**（#541 のレビュー）——**`MergeButton`
            // へ渡している `headSha` と、同じものを見る**（**無効なボタンの隣に
            // 「押せる」と出さない**）
            headKnown={(number) => result.plan.heads.get(number) !== undefined}
            // **番号だけの箱では「どれか」が分からない**（#542）——**取れなかったぶんは
            // `undefined` のまま渡す**（**空文字にすると「短いタイトル」に見える**）
            titleOf={(number) => result.plan.titles.get(number)}
            // **押す場所から現物へ行けるようにする**（#621）——**枝名は書いた人にしか
            // 読めない**ので、**何を approve / merge するのかが行に無かった。**
            // **組み立ては `infrastructure` が持ち、合成ルートを通す**（#622 の
            // レビュー 2 周目）——**`.` / `..` を断る判定を写さない**
            urlOf={(number) => pullRequestPageUrl({ owner, name }, number)}
            // **押せない理由を、押す前に出す**（#629）——**いまは Merge を押すまで
            // conflict が分からない**（#502 で踏んだ）。**判定は domain が持つ**
            // ——**取れていない PR は `undefined` のまま渡す**（**「マージできる」に
            // 化けさせない**）
            mergeStatusOf={(number) => result.plan.mergeStatuses.get(number)}
            // **誰の持ち物かを、行に出す**（#631）——**取れていない PR は `undefined` の
            // まま渡す**（**「誰も持っていない」に化けさせない**）
            assignmentOf={(number) => result.plan.assignments.get(number)}
            // **誰の番かを、行に出す**（#636）——**盤面を見て最初に知りたいのは
            // 「自分が動く番か」**である。**取れていない PR は `undefined` のまま
            // 渡す**（**「放置」に化けさせない**）
            reviewOpinionOf={(number) => result.plan.opinions.get(number)}
            // **行とボタンが逆のことを言わないようにする**（#652 のレビュー）
            // ——**`MergeButton` へ渡しているのと同じ `blocks`** である
            // （**1 度だけ作ったものを配る**。#541 のレビュー）
            mergeBlockOf={(number) => blocks?.get(number)}
            // **一覧を、誰の番かで絞る**（#663）——**運ぶ側（#667）と同じ値を渡す。**
            // **もう一度読み直さない**——**読み方が 2 つになると、片方だけが直る**
            ballFilter={ball}
            renderStatus={(number) => {
              // **押した結果は、盤面そのもので確かめる**（#343）
              const display = approvalDisplay(number, result.approvals);
              return display === undefined ? undefined : <ApprovalBadge kind={display} />;
            }}
            renderActions={(number) => (
              <>
                <ApproveButton
                  number={number}
                  action={`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/approve`}
                  // **絞ったまま押せるようにする**（#667）——**押すたびに
                  // 「すべて」へ戻ると、同じ区分を続けて処理できない**
                  ball={ball}
                />
                <MergeButton
                  number={number}
                  action={`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/merge`}
                  // **絞ったまま押せるようにする**（#667）
                  ball={ball}
                  // **盤面が見せている commit をそのまま渡す**（#331 のレビュー）
                  // ——**押した対象を、見せた対象に固定する**
                  headSha={result.plan.heads.get(number)}
                  // **依存が残っていれば押させない**（#345）。**判定は domain が持つ**
                  // ——**ここへ書き写すと、POST の口と食い違う**
                  // **読めなかった PR があれば、どの行も押させない**（#348 のレビュー）
                  // ——**辺が作られないので「依存なし」を信じられない。**
                  // **画面でも止める**（POST でも止まるが、**押しても断られると
                  // 分かっているものを押させるのは、理由が伝わる形ではない**）
                  // **知らない番号を「押せる」へ倒さない**（`mergeBlockFor` と同じ判断）
                  {...mergeButtonBlock(blocks?.get(number) ?? MISSING_BLOCK)}
                />
              </>
            )}
          />
          {/* **黙って捨てない。** **消すと「読めなかった」が「無かった」に化ける** */}
          {result.plan.invalid.length > 0 ? (
            <p className="text-sm opacity-70">{unreadableNote(result.plan.invalid.length)}</p>
          ) : undefined}
          {/* **issue の盤面**（#633）。**PR の並びをそのまま持ち込まない**
              ——**issue に「押せるか」は無い。** **一覧そのものは畳む**（#597）
              ——**常時見せるのは、順番を決める材料だけ**である */}
          <section className="flex flex-col gap-2">
            <h2 className="font-semibold text-lg">issue</h2>
            <IssueBoard
              {...issueBoardProps(result.issues)}
              // **組み立ては `infrastructure` が持ち、合成ルートを通す**（#622）
              urlOf={(number) => issuePageUrl({ owner, name }, number)}
            />
          </section>
        </>
      ) : (
        <p className="text-sm">
          {notice(result.kind)}{" "}
          {result.kind === "unavailable" ? undefined : (
            <a className="underline" href="/auth/login">
              ログインへ
            </a>
          )}
        </p>
      )}
    </main>
  );
}

export default async function RepositoryBoardPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly owner: string; readonly name: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return renderRepositoryBoard(await params, await searchParams, {
    board: repositoryBoardForCurrentUser,
    report: reportBoardActionUnavailable,
  });
}
