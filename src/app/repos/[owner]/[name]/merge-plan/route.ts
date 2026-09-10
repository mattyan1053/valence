/**
 * **マージ順のプランを受け付ける口**（#661）。
 *
 * **infrastructure を直に触らない**（§3）。**合成ルートだけを呼ぶ。**
 *
 * **#342 / #331 が決めた形をそのまま使う**——**同じ穴を開け直さない。**
 *
 * - **成功をクエリ文字列から出さない**（**語彙に無ければ渡せない**）
 * - **POST の本文は Zod で検証する**
 * - **応答は 303**（**`boardRedirect` を使う**）
 */

import { z } from "zod";
import type {
  MergePlanResult,
  MergePlanStep,
} from "../../../../../application/review-order/merge-plan";
import {
  mergePlanForCurrentUser,
  reportBoardActionUnavailable,
} from "../../../../../composition/auth";
import type { MergePlanNoticeKind } from "../../../../../ui/merge/merge-plan-button";
import { boardRedirect, submittedBallFilter } from "../board-redirect";

/**
 * 送られてきた 1 本（`<番号>:<commit>`）。**境界なので Zod で検証する**（§3）。
 *
 * **番号も commit も、`MergeButton` の口と同じ形で絞る**——**そのまま GitHub の
 * 要求へ載る値**なので、**commit として有り得ないものを通さない。**
 */
const stepSchema = z
  .string()
  .trim()
  .regex(/^[0-9]+:[0-9a-f]{40}$/)
  .transform((value) => {
    const [number, headSha] = value.split(":");
    return { number: Number(number), headSha: headSha as string };
  })
  .pipe(
    z.object({
      number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      headSha: z.string(),
    }),
  );

/**
 * 送られてきた並び。
 *
 * **1 つでも読めなければ、1 本も流さない**（#661 の「止める側へ倒す」）
 * ——**読めたぶんだけ流すと、見せていない並びで押すことになる。**
 */
export function planStepsFrom(values: readonly unknown[]): readonly MergePlanStep[] | undefined {
  const parsed = z
    .array(stepSchema)
    .min(1)
    // **同じ番号を 2 度含む並びは、1 本も流さない**（#665 のレビュー）
    // ——**番号が重なると、どの commit の話かが並びの中で 2 通りになる**。
    // **重なり自体を断つ**（**害が出るかどうかを数えに行かない**）
    .refine((steps) => new Set(steps.map((step) => step.number)).size === steps.length)
    .safeParse(values);
  return parsed.success ? parsed.data : undefined;
}

/**
 * 結果を、画面が出せる語彙へ寄せる。
 *
 * **成功は載せない**（#342 のレビュー）。**「入った本数」も載せない**
 * ——**流していない人が「N 本入りました」と出せる**（**取り消せない事実の主張**）。
 * **止まった番号は載せる**——**あれは「入らなかった」の側**である。
 *
 * **`not-found` をそのまま返さない**（§6）——**見えないリポジトリの存在を教える。**
 */
export function planOutcomeParam(
  result: MergePlanResult,
): { readonly value: MergePlanNoticeKind; readonly at?: number } | undefined {
  switch (result.kind) {
    case "ran":
      return result.stoppedAt === undefined
        ? // **全部入った。** **何も載せずに盤面へ戻す**
          undefined
        : { value: planStopKind(result.stoppedAt.reason), at: result.stoppedAt.number };
    case "forbidden":
      return { value: "forbidden" };
    case "nothing-to-run":
      return { value: "nothing-to-run" };
    default:
      // **`signed-out` / `needs-login` / `unavailable` / `not-found`**
      return { value: "unavailable" };
  }
}

/** 止まった理由を、画面の語彙へ。**知らない語は `unavailable` へ寄せる。** */
function planStopKind(reason: string): MergePlanNoticeKind {
  switch (reason) {
    case "not-approved":
    case "not-mergeable":
    case "dependency-pending":
    case "base-changed":
    case "not-orderable":
    case "forbidden":
      return reason;
    default:
      return "unavailable";
  }
}

/**
 * **サーバ側に残す理由**（#506 の 2）。
 *
 * **押した人へ理由が届いているものは残さない。**
 */
export function planUnavailableReason(result: MergePlanResult): string | undefined {
  if (planOutcomeParam(result)?.value !== "unavailable") {
    return undefined;
  }
  if (result.kind === "ran") {
    const stopped = result.stoppedAt;
    // **落ちどころも添える**（#506 の 2-b）
    const detail = stopped?.detail === undefined ? "" : `/${stopped.detail}`;
    return `stopped/${stopped?.reason ?? "unknown"}${detail}`;
  }
  return result.kind === "unavailable" && result.reason !== undefined
    ? `${result.kind}/${result.reason}`
    : result.kind;
}

/** **受け口を引数で渡す**（`MergeDeps` と同じ形）——**モックは使わない**（§4）。 */
export type MergePlanDeps = {
  readonly run: (
    repository: { readonly owner: string; readonly name: string },
    steps: readonly MergePlanStep[],
  ) => Promise<MergePlanResult>;
  readonly report: (action: "merge-plan", kind: string) => void;
};

export async function respondToMergePlan(
  request: Request,
  repository: { readonly owner: string; readonly name: string },
  deps: MergePlanDeps,
): Promise<Response> {
  const form = await request.formData().catch(() => undefined);
  const steps = planStepsFrom(form?.getAll("step") ?? []);
  // **絞ったまま流せるようにする**（#667）——**盤面の 3 つ目のフォーム**である
  const ball = submittedBallFilter(form);

  if (steps === undefined) {
    // **読めない要求で GitHub を叩かない**——**1 本も流さない**
    deps.report("merge-plan", "unreadable-request");
    return boardRedirect(request, repository, { param: "plan", value: "unavailable" }, ball);
  }

  const result = await deps.run(repository, steps);
  const outcome = planOutcomeParam(result);
  const reason = planUnavailableReason(result);
  if (reason !== undefined) {
    deps.report("merge-plan", reason);
  }
  return boardRedirect(
    request,
    repository,
    outcome === undefined ? undefined : { param: "plan", ...outcome },
    ball,
  );
}

export async function POST(
  request: Request,
  { params }: { readonly params: Promise<{ readonly owner: string; readonly name: string }> },
): Promise<Response> {
  const { owner, name } = await params;
  return respondToMergePlan(
    request,
    { owner, name },
    { run: mergePlanForCurrentUser, report: reportBoardActionUnavailable },
  );
}
