/**
 * **マージ順のプランを、順に流す**（#661）。
 *
 * **順序はもう出ている**（`DependencyOrder.ordered`）。**流すのだけが手作業**だった。
 *
 * **1 本ずつ入れる。** **1 本目が入った時点で 2 本目の base は動く**ので、
 * **「いま入れられるか」は入れるたびにやり直す**——**先にまとめて判定して流すと、
 * 古い判定で押すことになる**（#331 と同じ向き）。**判定は `mergePullRequest` が持つ**
 * （**ここへ写さない**。`AGENTS.md` §5）。
 *
 * **止める側へ倒す。** **落ちたら残りを流さない**——**進むほうが取り返しがつかない**
 * （**マージは取り消せない**）。**#587 で踏んだ形**でもある。
 *
 * **どこまで進んだかを返す。** **失敗の 1 行だけを返して終わらない**
 * ——**「1 本も入っていない」と「2 本目で止まった」は別の状態**である（#191 のレビュー）。
 */

import { authorizeRepository } from "../auth/authorize-repository";
import type { UsableToken } from "../auth/ensure-usable-token";
import { errorKind } from "../observability/error-kind";
import type {
  PullRequestApprovalListing,
  PullRequestApprovals,
} from "../ports/pull-request-approvals";
import type { RepositoryPermissions } from "../ports/repository-permissions";
import type { UserTokenStore } from "../ports/user-token-store";
import type { VisibleRepositories, VisibleRepository } from "../ports/visible-repositories";
import type { MergePullRequestResult } from "./merge-pull-request";

/**
 * 流す 1 本。
 *
 * **commit まで持つ**（#331）——**押した対象を、盤面が見せた対象に固定する。**
 */
export type MergePlanStep = {
  readonly number: number;
  readonly headSha: string;
};

/**
 * 止まった理由。
 *
 * **`MergePullRequestResult` の `kind` をそのまま運ぶ**（**言い換えると、
 * 1 本ずつ押したときと違う語になる**）。**`not-approved` だけは、ここで足す**
 * ——**見せた commit を承認していない PR を、まとめて信じないため**である（#635）。
 */
export type MergePlanStopReason = MergePullRequestResult["kind"] | "not-approved";

export type MergePlanResult =
  /** ログインしていない。**誰の権限も無いので、何もしない**（§6）。 */
  | { readonly kind: "signed-out" }
  | { readonly kind: "needs-login" }
  | { readonly kind: "unavailable"; readonly reason?: string }
  /** **そのユーザーには無い**（§6。**「見えない」と「存在しない」を分けない**）。 */
  | { readonly kind: "not-found" }
  /** **見えるが、マージしてよい権限が無い。** */
  | { readonly kind: "forbidden" }
  /**
   * **流すものが 1 本も無い。**
   *
   * **「0 本入った」と混ぜない**——**押した人が次にすることが違う**
   * （**盤面を見直す**のであって、**結果を確かめる**のではない）。
   */
  | { readonly kind: "nothing-to-run" }
  /**
   * **流した。** **どこまで進んだかを持つ。**
   *
   * **`stoppedAt` が無ければ、全部入った。** **あれば、その PR で止まっている**
   * ——**`remaining` には、止まった PR 自身も入る**（**入っていないため**）。
   */
  | {
      readonly kind: "ran";
      readonly merged: readonly number[];
      readonly stoppedAt?: {
        readonly number: number;
        readonly reason: MergePlanStopReason;
        /** **落ちどころ**（#506 の 2-b）。**画面には出さない**（§6）。 */
        readonly detail?: string;
      };
      readonly remaining: readonly number[];
    };

export type MergePlanInput = {
  /** どのリポジトリか。**要求ごとに決まる**（§1）。 */
  readonly repository: VisibleRepository;
  /** **依存の順に並んだ、流す本たち。** **並べるのは呼ぶ側**である。 */
  readonly steps: readonly MergePlanStep[];
  /** **開く手続きごと受ける**（`mergePullRequest` と同じ形）。 */
  readonly openStore: () => Promise<UserTokenStore | undefined>;
  readonly ensure: (store: UserTokenStore) => Promise<UsableToken>;
  readonly repositories: VisibleRepositories;
  /** **`write` を要求する**ので、ここでは引かれる。 */
  readonly permissions: RepositoryPermissions;
  /**
   * 承認の状態を読む口（#343 / #635）。
   *
   * **見せた commit で問い合わせる**——**番号だけで聞くと、口は「どの差分の話か」を
   * 知らないまま答える。**
   *
   * **入れる直前に、その 1 本だけ聞く**（#665 のレビュー）——**まとめて先に聞くと、
   * 流している間に外れた承認を見逃す**（**先の本が入るまでには時間がある**）。
   * **`mergePullRequest` は承認を見ない**ので、**ここで見なければ誰も見ていない。**
   */
  readonly approvals: PullRequestApprovals;
  /**
   * 1 本を入れる手続き。**判定はこの中にある**（`mergePullRequest`）。
   *
   * **手続きごと受ける**ので、**この流れは「順に呼ぶ」と「どこで止まったか」だけを持つ。**
   */
  readonly merge: (step: MergePlanStep) => Promise<MergePullRequestResult>;
};

export async function mergePlan({
  repository,
  steps,
  openStore,
  ensure,
  repositories,
  permissions,
  approvals,
  merge,
}: MergePlanInput): Promise<MergePlanResult> {
  // **認可は共有の判断が持つ** (#315)——**ここへ写すと、盤面・Approve・Merge と
  // 片方だけ直したときに食い違う。**
  const authorization = await authorizeRepository({
    repository,
    openStore,
    ensure,
    repositories,
    permissions,
    require: "write",
  });
  if (authorization.kind !== "authorized") {
    return authorization;
  }
  // **押してよいと分かってから数える**——**0 本でも、権限の答えは先に出す**
  if (steps.length === 0) {
    return { kind: "nothing-to-run" };
  }

  const merged: number[] = [];
  for (const [index, step] of steps.entries()) {
    const stop = (reason: MergePlanStopReason, detail?: string): MergePlanResult => ({
      kind: "ran",
      merged,
      stoppedAt:
        detail === undefined
          ? { number: step.number, reason }
          : { number: step.number, reason, detail },
      // **止まった本人も残りに入れる**——**入っていないため**
      remaining: steps.slice(index).map((rest) => rest.number),
    });

    let listing: PullRequestApprovalListing;
    try {
      // **入れる直前に、この 1 本の commit で聞く**（#635 / #665 のレビュー）
      // ——**先の本が入るまでの間に、承認は外れうる**
      listing = await approvals.listApprovals(
        authorization.userAccessToken,
        repository,
        new Map([[step.number, step.headSha]]),
      );
    } catch (error) {
      // **読めなかったものを「承認済み」へ倒さない**——**そこで止める。**
      // **`unavailable` を返さない**——**ここまでに入ったぶんが消える**（#191 のレビュー）
      return stop("unavailable", `approvals/${errorKind(error)}`);
    }
    // **口は投げるとは限らない**（#665 のレビュー）——**閉じた PR や一覧から
    // 落ちたものは `unavailable` に入って返る。** **`approved` に無いことだけを見ると、
    // 「読めなかった」が「承認されていない」に化ける**——**この口が分けたもの**である
    if (listing.unavailable.some((one) => one.pullRequestNumber === step.number)) {
      // **理由の文面は運ばない**（§6）——**落ちどころは種類だけ**（#506 の 2-b）
      return stop("unavailable", "approvals/unreadable");
    }
    if (!listing.approved.has(step.number)) {
      return stop("not-approved");
    }
    // **入れるたびに判定をやり直す**（`mergePullRequest` の中）——**1 本入ると、
    // 次の base が動く**
    const result = await merge(step);
    if (result.kind !== "merged") {
      return stop(result.kind);
    }
    merged.push(step.number);
  }
  return { kind: "ran", merged, remaining: [] };
}
