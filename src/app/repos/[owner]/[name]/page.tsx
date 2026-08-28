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
import type { PullRequestApprovalListing } from "../../../../application/ports/pull-request-approvals";
import type { RepositoryBoardResult } from "../../../../application/review-order/view-repository-board";
import {
  reportBoardActionUnavailable,
  repositoryBoardForCurrentUser,
} from "../../../../composition/auth";
import type { MergeBlock } from "../../../../domain/graph/merge-block";
import { mergeBlocksFor } from "../../../../domain/graph/merge-block";
import type { ApprovalDisplayKind } from "../../../../ui/approve/approval-badge";
import { ApprovalBadge } from "../../../../ui/approve/approval-badge";
import type { ApproveNoticeKind } from "../../../../ui/approve/approve-button";
import { ApproveButton, approveNotice } from "../../../../ui/approve/approve-button";
import type { MergeNoticeKind } from "../../../../ui/merge/merge-button";
import { MergeButton, mergeNotice } from "../../../../ui/merge/merge-button";
import { ReviewBoard } from "../../../../ui/review-board/review-board";

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
export function approveNoticeKind(value: unknown): ApproveNoticeKind | undefined {
  return value === "forbidden" || value === "self-approval" || value === "unavailable"
    ? value
    : undefined;
}

/**
 * 直前に**マージできなかった**理由。**知らない値は出さない**（#331）。
 *
 * **成功はここから出さない**（#342 のレビューと同じ）——**`?merge=merged` を
 * 開くだけで「マージしました」と出てはならない。**
 */
export function mergeNoticeKind(value: unknown): MergeNoticeKind | undefined {
  return value === "forbidden" ||
    value === "not-mergeable" ||
    value === "dependency-pending" ||
    value === "not-orderable" ||
    value === "base-changed" ||
    value === "unavailable"
    ? value
    : undefined;
}

/**
 * その PR について、盤面に出す状態（#343）。
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
 * 依存の判定を、ボタンが受け取る形へ直す（#345）。
 *
 * **判定そのものは `mergeBlockFor` が持つ**——**ここは詰め替えるだけ**である
 * （**POST の口も同じ関数を通る**ので、**画面と食い違わない**）。
 */
export function mergeButtonBlock(block: MergeBlock): {
  readonly blockedBy?: readonly number[];
  readonly notOrderable?: boolean;
} {
  switch (block.kind) {
    case "depends-on":
      return { blockedBy: block.numbers };
    case "not-orderable":
      return { notOrderable: true };
    case "ready":
      return {};
  }
}

/**
 * **盤面を出せなかった理由** (#513 のレビュー)。
 *
 * **押した経路と同じものが、見に来た経路にもある**——**`store` / `list` /
 * `token` / `board` で落ちると、画面には「いま見られません」しか出ない**（§6）
 * ので、**サーバ側に残さないと、どこで落ちたかが消える。**
 *
 * **画面に出す語（`notice`）は変えない。** **残すのは記録だけ**である。
 */
export function boardUnavailableReason(result: {
  readonly kind: string;
  readonly reason?: string;
}): string | undefined {
  if (result.kind !== "unavailable") {
    return undefined;
  }
  return result.reason === undefined ? result.kind : `${result.kind}/${result.reason}`;
}

/**
 * **盤面を組み立てるまで** (#519)。
 *
 * **受け口を引数で渡す**——**画面から呼ぶと composition が本物を掴む**ので、
 * **「記録の口を呼んでいること」を試験から見られない**（**#513 のレビューで
 * 1 度戻し、そのときは見送った穴**——**呼び出しを消しても部品の試験は緑だった**）。
 * **モックは使わない**（`AGENTS.md` §4）——**インメモリの実装を渡す形にする。**
 *
 * **判定は `boardUnavailableReason` のまま 1 箇所である**（§5）。
 */
export type BoardPageDeps = {
  /** 盤面を引く口（`repositoryBoardForCurrentUser`）。 */
  readonly board: (repository: {
    readonly owner: string;
    readonly name: string;
  }) => Promise<RepositoryBoardResult>;
  /** 出せなかった理由を残す口（`reportBoardActionUnavailable`）。 */
  readonly report: (action: "view", kind: string) => void;
};

export async function renderRepositoryBoard(
  { owner, name }: { readonly owner: string; readonly name: string },
  query: Record<string, string | string[] | undefined>,
  deps: BoardPageDeps,
) {
  const outcome = approveNoticeKind(query.approve);
  const mergeOutcome = mergeNoticeKind(query.merge);
  const result = await deps.board({ owner, name });
  // **落ちどころを、サーバ側に残す** (#513 のレビュー)——**押した経路と同じ**
  const unavailable = boardUnavailableReason(result);
  if (unavailable !== undefined) {
    deps.report("view", unavailable);
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
      <h1 className="font-mono text-2xl font-bold tracking-tight">
        {owner}/{name}
      </h1>
      {/* **押せなかった理由は、押した画面に出す** */}
      {outcome === undefined ? undefined : <p className="text-sm">{approveNotice(outcome)}</p>}
      {mergeOutcome === undefined ? undefined : (
        <p className="text-sm">{mergeNotice(mergeOutcome)}</p>
      )}
      {result.kind === "board" ? (
        <>
          <ReviewBoard
            pullRequests={result.plan.pullRequests}
            edges={result.plan.edges}
            order={result.plan.order}
            invalid={result.plan.invalid}
            changes={result.plan.changes}
            // **図の札を、ボタンと同じ条件にする**（#541 のレビュー）——**`MergeButton`
            // へ渡している `headSha` と、同じものを見る**（**無効なボタンの隣に
            // 「押せる」と出さない**）
            headKnown={(number) => result.plan.heads.get(number) !== undefined}
            // **番号だけの箱では「どれか」が分からない**（#542）——**取れなかったぶんは
            // `undefined` のまま渡す**（**空文字にすると「短いタイトル」に見える**）
            titleOf={(number) => result.plan.titles.get(number)}
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
                />
                <MergeButton
                  number={number}
                  action={`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/merge`}
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
                  {...mergeButtonBlock(blocks?.get(number) ?? { kind: "not-orderable" })}
                />
              </>
            )}
          />
          {/* **黙って捨てない。** **消すと「読めなかった」が「無かった」に化ける** */}
          {result.plan.invalid.length > 0 ? (
            <p className="text-sm opacity-70">{unreadableNote(result.plan.invalid.length)}</p>
          ) : undefined}
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
